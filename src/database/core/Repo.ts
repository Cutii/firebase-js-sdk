import {
  generateWithValues,
  resolveDeferredValueSnapshot,
  resolveDeferredValueTree
} from "./util/ServerValues";
import { nodeFromJSON } from "./snap/nodeFromJSON";
import { Path } from "./util/Path";
import { SparseSnapshotTree } from "./SparseSnapshotTree";
import { SyncTree } from "./SyncTree";
import { SnapshotHolder } from "./SnapshotHolder";
import { stringify } from "../../utils/json";
import { beingCrawled, each, exceptionGuard, warn, log } from "./util/util";
import { map, forEach, isEmpty } from "../../utils/obj";
import { AuthTokenProvider } from "./AuthTokenProvider";
import { StatsManager } from "./stats/StatsManager";
import { StatsReporter } from "./stats/StatsReporter";
import { StatsListener } from "./stats/StatsListener";
import { EventQueue } from "./view/EventQueue";
import { PersistentConnection } from "./PersistentConnection";
import { ReadonlyRestClient } from "./ReadonlyRestClient";
import { FirebaseApp } from "../../app/firebase_app";
import { RepoInfo } from "./RepoInfo";
import { Database } from "../api/Database";
import { ServerActions } from "./ServerActions";
import { Query } from "../api/Query";
import { EventRegistration } from "./view/EventRegistration";

const INTERRUPT_REASON = "repo_interrupt";

/**
 * A connection to a single data repository.
 */
export class Repo {
  /** @type {!Database} */
  database: Database;
  infoSyncTree_: SyncTree;
  dataUpdateCount;
  serverSyncTree_: SyncTree;

  private repoInfo_;
  private stats_;
  private statsListener_;
  private eventQueue_;
  private nextWriteId_;
  private server_: ServerActions;
  private statsReporter_;
  private transactions_init_;
  private infoData_;
  private onDisconnect_;
  private abortTransactions_;
  private rerunTransactions_;
  private interceptServerDataCallback_;

  /**
   * TODO: This should be @private but it's used by test_access.js and internal.js
   * @type {?PersistentConnection}
   */
  persistentConnection_: PersistentConnection | null = null;

  /**
   * @param {!RepoInfo} repoInfo
   * @param {boolean} forceRestClient
   * @param {!FirebaseApp} app
   */
  constructor(
    repoInfo: RepoInfo,
    forceRestClient: boolean,
    public app: FirebaseApp
  ) {
    /** @type {!AuthTokenProvider} */
    const authTokenProvider = new AuthTokenProvider(app);

    this.repoInfo_ = repoInfo;
    this.stats_ = StatsManager.getCollection(repoInfo);
    /** @type {StatsListener} */
    this.statsListener_ = null;
    this.eventQueue_ = new EventQueue();
    this.nextWriteId_ = 1;

    if (forceRestClient || beingCrawled()) {
      this.server_ = new ReadonlyRestClient(
        this.repoInfo_,
        this.onDataUpdate_.bind(this),
        authTokenProvider
      );

      // Minor hack: Fire onConnect immediately, since there's no actual connection.
      setTimeout(this.onConnectStatus_.bind(this, true), 0);
    } else {
      const authOverride = app.options["databaseAuthVariableOverride"];
      // Validate authOverride
      if (typeof authOverride !== "undefined" && authOverride !== null) {
        if (authOverride !== "object") {
          throw new Error(
            "Only objects are supported for option databaseAuthVariableOverride"
          );
        }
        try {
          stringify(authOverride);
        } catch (e) {
          throw new Error("Invalid authOverride provided: " + e);
        }
      }

      this.persistentConnection_ = new PersistentConnection(
        this.repoInfo_,
        this.onDataUpdate_.bind(this),
        this.onConnectStatus_.bind(this),
        this.onServerInfoUpdate_.bind(this),
        authTokenProvider,
        authOverride
      );

      this.server_ = this.persistentConnection_;
    }

    authTokenProvider.addTokenChangeListener(token => {
      this.server_.refreshAuthToken(token);
    });

    // In the case of multiple Repos for the same repoInfo (i.e. there are multiple Firebase.Contexts being used),
    // we only want to create one StatsReporter.  As such, we'll report stats over the first Repo created.
    this.statsReporter_ = StatsManager.getOrCreateReporter(
      repoInfo,
      () => new StatsReporter(this.stats_, this.server_)
    );

    this.transactions_init_();

    // Used for .info.
    this.infoData_ = new SnapshotHolder();
    this.infoSyncTree_ = new SyncTree({
      startListening: (query, tag, currentHashFn, onComplete) => {
        let infoEvents = [];
        const node = this.infoData_.getNode(query.path);
        // This is possibly a hack, but we have different semantics for .info endpoints. We don't raise null events
        // on initial data...
        if (!node.isEmpty()) {
          infoEvents = this.infoSyncTree_.applyServerOverwrite(
            query.path,
            node
          );
          setTimeout(() => {
            onComplete("ok");
          }, 0);
        }
        return infoEvents;
      },
      stopListening: () => {}
    });
    this.updateInfo_("connected", false);

    // A list of data pieces and paths to be set when this client disconnects.
    this.onDisconnect_ = new SparseSnapshotTree();

    this.dataUpdateCount = 0;

    this.interceptServerDataCallback_ = null;

    this.serverSyncTree_ = new SyncTree({
      startListening: (query, tag, currentHashFn, onComplete) => {
        this.server_.listen(query, currentHashFn, tag, (status, data) => {
          const events = onComplete(status, data);
          this.eventQueue_.raiseEventsForChangedPath(query.path, events);
        });
        // No synchronous events for network-backed sync trees
        return [];
      },
      stopListening: (query, tag) => {
        this.server_.unlisten(query, tag);
      }
    });
  }

  /**
   * @return {string}  The URL corresponding to the root of this Firebase.
   */
  toString(): string {
    return (
      (this.repoInfo_.secure ? "https://" : "http://") + this.repoInfo_.host
    );
  }

  /**
   * @return {!string} The namespace represented by the repo.
   */
  name(): string {
    return this.repoInfo_.namespace;
  }

  /**
   * @return {!number} The time in milliseconds, taking the server offset into account if we have one.
   */
  serverTime(): number {
    const offsetNode = this.infoData_.getNode(
      new Path(".info/serverTimeOffset")
    );
    const offset = /** @type {number} */ offsetNode.val() || 0;
    return new Date().getTime() + offset;
  }

  /**
   * Generate ServerValues using some variables from the repo object.
   * @return {!Object}
   */
  generateServerValues(): Object {
    return generateWithValues({
      timestamp: this.serverTime()
    });
  }

  /**
   * Called by realtime when we get new messages from the server.
   *
   * @private
   * @param {string} pathString
   * @param {*} data
   * @param {boolean} isMerge
   * @param {?number} tag
   */
  private onDataUpdate_(
    pathString: string,
    data: any,
    isMerge: boolean,
    tag: number | null
  ) {
    // For testing.
    this.dataUpdateCount++;
    const path = new Path(pathString);
    data = this.interceptServerDataCallback_
      ? this.interceptServerDataCallback_(pathString, data)
      : data;
    let events = [];
    if (tag) {
      if (isMerge) {
        const taggedChildren = map /**@type {!Object.<string, *>} */(
          data,
          raw => nodeFromJSON(raw)
        );
        events = this.serverSyncTree_.applyTaggedQueryMerge(
          path,
          taggedChildren,
          tag
        );
      } else {
        const taggedSnap = nodeFromJSON(data);
        events = this.serverSyncTree_.applyTaggedQueryOverwrite(
          path,
          taggedSnap,
          tag
        );
      }
    } else if (isMerge) {
      const changedChildren = map /**@type {!Object.<string, *>} */(data, raw =>
        nodeFromJSON(raw)
      );
      events = this.serverSyncTree_.applyServerMerge(path, changedChildren);
    } else {
      const snap = nodeFromJSON(data);
      events = this.serverSyncTree_.applyServerOverwrite(path, snap);
    }
    let affectedPath = path;
    if (events.length > 0) {
      // Since we have a listener outstanding for each transaction, receiving any events
      // is a proxy for some change having occurred.
      affectedPath = this.rerunTransactions_(path);
    }
    this.eventQueue_.raiseEventsForChangedPath(affectedPath, events);
  }

  /**
   * @param {?function(!string, *):*} callback
   * @private
   */
  private interceptServerData_(callback: (a: string, b: any) => any) {
    this.interceptServerDataCallback_ = callback;
  }

  /**
   * @param {!boolean} connectStatus
   * @private
   */
  private onConnectStatus_(connectStatus: boolean) {
    this.updateInfo_("connected", connectStatus);
    if (connectStatus === false) {
      this.runOnDisconnectEvents_();
    }
  }

  /**
   * @param {!Object} updates
   * @private
   */
  private onServerInfoUpdate_(updates: Object) {
    each(updates, (value: any, key: string) => {
      this.updateInfo_(key, value);
    });
  }

  /**
   *
   * @param {!string} pathString
   * @param {*} value
   * @private
   */
  private updateInfo_(pathString: string, value: any) {
    const path = new Path("/.info/" + pathString);
    const newNode = nodeFromJSON(value);
    this.infoData_.updateSnapshot(path, newNode);
    const events = this.infoSyncTree_.applyServerOverwrite(path, newNode);
    this.eventQueue_.raiseEventsForChangedPath(path, events);
  }

  /**
   * @return {!number}
   * @private
   */
  private getNextWriteId_(): number {
    return this.nextWriteId_++;
  }

  /**
   * @param {!Path} path
   * @param {*} newVal
   * @param {number|string|null} newPriority
   * @param {?function(?Error, *=)} onComplete
   */
  setWithPriority(
    path: Path,
    newVal: any,
    newPriority: number | string | null,
    onComplete: ((status: Error | null, errorReason?: string) => any) | null
  ) {
    this.log_("set", {
      path: path.toString(),
      value: newVal,
      priority: newPriority
    });

    // TODO: Optimize this behavior to either (a) store flag to skip resolving where possible and / or
    // (b) store unresolved paths on JSON parse
    const serverValues = this.generateServerValues();
    const newNodeUnresolved = nodeFromJSON(newVal, newPriority);
    const newNode = resolveDeferredValueSnapshot(
      newNodeUnresolved,
      serverValues
    );

    const writeId = this.getNextWriteId_();
    const events = this.serverSyncTree_.applyUserOverwrite(
      path,
      newNode,
      writeId,
      true
    );
    this.eventQueue_.queueEvents(events);
    this.server_.put(
      path.toString(),
      newNodeUnresolved.val(/*export=*/ true),
      (status, errorReason) => {
        const success = status === "ok";
        if (!success) {
          warn("set at " + path + " failed: " + status);
        }

        const clearEvents = this.serverSyncTree_.ackUserWrite(
          writeId,
          !success
        );
        this.eventQueue_.raiseEventsForChangedPath(path, clearEvents);
        this.callOnCompleteCallback(onComplete, status, errorReason);
      }
    );
    const affectedPath = this.abortTransactions_(path);
    this.rerunTransactions_(affectedPath);
    // We queued the events above, so just flush the queue here
    this.eventQueue_.raiseEventsForChangedPath(affectedPath, []);
  }

  /**
   * @param {!Path} path
   * @param {!Object} childrenToMerge
   * @param {?function(?Error, *=)} onComplete
   */
  update(
    path: Path,
    childrenToMerge: Object,
    onComplete: ((status: Error | null, errorReason?: string) => any) | null
  ) {
    this.log_("update", { path: path.toString(), value: childrenToMerge });

    // Start with our existing data and merge each child into it.
    let empty = true;
    const serverValues = this.generateServerValues();
    const changedChildren = {};
    forEach(childrenToMerge, function(changedKey, changedValue) {
      empty = false;
      const newNodeUnresolved = nodeFromJSON(changedValue);
      changedChildren[changedKey] = resolveDeferredValueSnapshot(
        newNodeUnresolved,
        serverValues
      );
    });

    if (!empty) {
      const writeId = this.getNextWriteId_();
      const events = this.serverSyncTree_.applyUserMerge(
        path,
        changedChildren,
        writeId
      );
      this.eventQueue_.queueEvents(events);
      this.server_.merge(
        path.toString(),
        childrenToMerge,
        (status, errorReason) => {
          const success = status === "ok";
          if (!success) {
            warn("update at " + path + " failed: " + status);
          }

          const clearEvents = this.serverSyncTree_.ackUserWrite(
            writeId,
            !success
          );
          const affectedPath =
            clearEvents.length > 0 ? this.rerunTransactions_(path) : path;
          this.eventQueue_.raiseEventsForChangedPath(affectedPath, clearEvents);
          this.callOnCompleteCallback(onComplete, status, errorReason);
        }
      );

      forEach(childrenToMerge, (changedPath, changedValue) => {
        const affectedPath = this.abortTransactions_(path.child(changedPath));
        this.rerunTransactions_(affectedPath);
      });

      // We queued the events above, so just flush the queue here
      this.eventQueue_.raiseEventsForChangedPath(path, []);
    } else {
      log("update() called with empty data.  Don't do anything.");
      this.callOnCompleteCallback(onComplete, "ok");
    }
  }

  /**
   * Applies all of the changes stored up in the onDisconnect_ tree.
   * @private
   */
  private runOnDisconnectEvents_() {
    this.log_("onDisconnectEvents");

    const serverValues = this.generateServerValues();
    const resolvedOnDisconnectTree = resolveDeferredValueTree(
      this.onDisconnect_,
      serverValues
    );
    let events = [];

    resolvedOnDisconnectTree.forEachTree(Path.Empty, (path, snap) => {
      events = events.concat(
        this.serverSyncTree_.applyServerOverwrite(path, snap)
      );
      const affectedPath = this.abortTransactions_(path);
      this.rerunTransactions_(affectedPath);
    });

    this.onDisconnect_ = new SparseSnapshotTree();
    this.eventQueue_.raiseEventsForChangedPath(Path.Empty, events);
  }

  /**
   * @param {!Path} path
   * @param {?function(?Error, *=)} onComplete
   */
  onDisconnectCancel(
    path: Path,
    onComplete: ((status: Error | null, errorReason?: string) => any) | null
  ) {
    this.server_.onDisconnectCancel(path.toString(), (status, errorReason) => {
      if (status === "ok") {
        this.onDisconnect_.forget(path);
      }
      this.callOnCompleteCallback(onComplete, status, errorReason);
    });
  }

  /**
   * @param {!Path} path
   * @param {*} value
   * @param {?function(?Error, *=)} onComplete
   */
  onDisconnectSet(
    path: Path,
    value: any,
    onComplete: ((status: Error | null, errorReason?: string) => any) | null
  ) {
    const newNode = nodeFromJSON(value);
    this.server_.onDisconnectPut(
      path.toString(),
      newNode.val(/*export=*/ true),
      (status, errorReason) => {
        if (status === "ok") {
          this.onDisconnect_.remember(path, newNode);
        }
        this.callOnCompleteCallback(onComplete, status, errorReason);
      }
    );
  }

  /**
   * @param {!Path} path
   * @param {*} value
   * @param {*} priority
   * @param {?function(?Error, *=)} onComplete
   */
  onDisconnectSetWithPriority(
    path,
    value,
    priority,
    onComplete: ((status: Error | null, errorReason?: string) => any) | null
  ) {
    const newNode = nodeFromJSON(value, priority);
    this.server_.onDisconnectPut(
      path.toString(),
      newNode.val(/*export=*/ true),
      (status, errorReason) => {
        if (status === "ok") {
          this.onDisconnect_.remember(path, newNode);
        }
        this.callOnCompleteCallback(onComplete, status, errorReason);
      }
    );
  }

  /**
   * @param {!Path} path
   * @param {*} childrenToMerge
   * @param {?function(?Error, *=)} onComplete
   */
  onDisconnectUpdate(
    path,
    childrenToMerge,
    onComplete: ((status: Error | null, errorReason?: string) => any) | null
  ) {
    if (isEmpty(childrenToMerge)) {
      log(
        "onDisconnect().update() called with empty data.  Don't do anything."
      );
      this.callOnCompleteCallback(onComplete, "ok");
      return;
    }

    this.server_.onDisconnectMerge(
      path.toString(),
      childrenToMerge,
      (status, errorReason) => {
        if (status === "ok") {
          forEach(childrenToMerge, (childName: string, childNode: any) => {
            const newChildNode = nodeFromJSON(childNode);
            this.onDisconnect_.remember(path.child(childName), newChildNode);
          });
        }
        this.callOnCompleteCallback(onComplete, status, errorReason);
      }
    );
  }

  /**
   * @param {!Query} query
   * @param {!EventRegistration} eventRegistration
   */
  addEventCallbackForQuery(query: Query, eventRegistration: EventRegistration) {
    let events;
    if (query.path.getFront() === ".info") {
      events = this.infoSyncTree_.addEventRegistration(
        query,
        eventRegistration
      );
    } else {
      events = this.serverSyncTree_.addEventRegistration(
        query,
        eventRegistration
      );
    }
    this.eventQueue_.raiseEventsAtPath(query.path, events);
  }

  /**
   * @param {!Query} query
   * @param {?EventRegistration} eventRegistration
   */
  removeEventCallbackForQuery(
    query: Query,
    eventRegistration: EventRegistration
  ) {
    // These are guaranteed not to raise events, since we're not passing in a cancelError. However, we can future-proof
    // a little bit by handling the return values anyways.
    let events;
    if (query.path.getFront() === ".info") {
      events = this.infoSyncTree_.removeEventRegistration(
        query,
        eventRegistration
      );
    } else {
      events = this.serverSyncTree_.removeEventRegistration(
        query,
        eventRegistration
      );
    }
    this.eventQueue_.raiseEventsAtPath(query.path, events);
  }

  interrupt() {
    if (this.persistentConnection_) {
      this.persistentConnection_.interrupt(INTERRUPT_REASON);
    }
  }

  resume() {
    if (this.persistentConnection_) {
      this.persistentConnection_.resume(INTERRUPT_REASON);
    }
  }

  stats(showDelta: boolean = false) {
    if (typeof console === "undefined") return;

    let stats;
    if (showDelta) {
      if (!this.statsListener_)
        this.statsListener_ = new StatsListener(this.stats_);
      stats = this.statsListener_.get();
    } else {
      stats = this.stats_.get();
    }

    const longestName = Object.keys(stats).reduce(function(
      previousValue,
      currentValue,
      index,
      array
    ) {
      return Math.max(currentValue.length, previousValue);
    }, 0);

    forEach(stats, (stat, value) => {
      // pad stat names to be the same length (plus 2 extra spaces).
      for (let i = stat.length; i < longestName + 2; i++) stat += " ";
      console.log(stat + value);
    });
  }

  statsIncrementCounter(metric) {
    this.stats_.incrementCounter(metric);
    this.statsReporter_.includeStat(metric);
  }

  /**
   * @param {...*} var_args
   * @private
   */
  private log_(...var_args: any[]) {
    let prefix = "";
    if (this.persistentConnection_) {
      prefix = this.persistentConnection_.id + ":";
    }
    log(prefix, var_args);
  }

  /**
   * @param {?function(?Error, *=)} callback
   * @param {!string} status
   * @param {?string=} errorReason
   */
  callOnCompleteCallback(
    callback: ((status: Error | null, errorReason?: string) => any) | null,
    status: string,
    errorReason?: string | null
  ) {
    if (callback) {
      exceptionGuard(function() {
        if (status == "ok") {
          callback(null);
        } else {
          const code = (status || "error").toUpperCase();
          let message = code;
          if (errorReason) message += ": " + errorReason;

          const error = new Error(message);
          (error as any).code = code;
          callback(error);
        }
      });
    }
  }
}
