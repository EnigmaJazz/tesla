// Mock Tasker runtime for the test harness.
// Tasker scripts call local(key), setLocal(key, value), global(key), setGlobal,
// readFile(path), writeFile(path, content), deleteFile(path), flash(message),
// Date.now() and use built-ins like Math, JSON, parseInt, isNaN. This module
// builds a vm sandbox that mimics the runtime and exposes a live store the test
// can inspect after the script has run.
//
// Failure injection (options.failures):
//   writeThrows  - array of path substrings; writeFile throws if any match.
//   tornWrites   - array of path substrings; the FIRST write to a matching
//                  path is stored truncated so read-back detection rejects it,
//                  then the fault heals (one-shot) so a retry/restore write
//                  succeeds — modelling a real torn write + rollback.
//
// Store observability:
//   store.writeLog   - every writeFile and deleteFile call with op/path/length
//                      and the owner row (the __currentScriptPath that made the
//                      call, or null) so tests can prove which script wrote it.
//   store.writeOrder - ordered list of paths passed to writeFile.
//   store.deleteOrder- ordered list of paths passed to deleteFile.

const path = require('node:path');
const { runScript } = require('./runner');

const PUBLISHER_PATH = path.resolve(__dirname, '..', 'Generation_Publisher.js');
const REDUCER_PATH = path.resolve(__dirname, '..', 'Trip_State_Reducer.js');
const OVERRIDE_HANDLER_PATH = path.resolve(__dirname, '..', 'Override_Handler.js');
const STATE_COMMAND_PATH = path.resolve(__dirname, '..', 'TDS_State_Command.js');
const CACHE_MANAGER_PATH = path.resolve(__dirname, '..', 'Route_Cache_Manager.js');
const PHASE3_STATE_PATH = "Tasker/Tesla/Data/TDS_Trip_State.json";
const REORDER_QUEUE_PATH = "Tasker/Tesla/Data/TDS_Reorder_Commands.json";
const OVERRIDE_PATH = "Tasker/Tesla/Data/TDS_Overrides.json";
const PREFS_PATH = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";
const SESSIONS_PATH = "Tasker/Tesla/Data/TDS_Action_Sessions.json";
const MANUAL_TRIPS_PATH = "Tasker/Tesla/Data/TDS_Manual_Trips.json";
const ACTION_LOCK_PATH = "Tasker/Tesla/Data/TDS_Action_Lock.json";
// Phase 5 Slice B (REQ-5CACHE-1, RULE-8E): the Route Cache Manager is the sole
// writer of the four cache JSON files AND their legacy text projections.
const ROUTE_CACHE_PATH = "Tasker/Tesla/Data/TDS_Route_Cache.json";
const ORDER_CACHE_PATH = "Tasker/Tesla/Data/TDS_Order_Cache.json";
const TEMP_CACHE_PATH = "Tasker/Tesla/Data/Temp_Route_Cache.json";
const REQUEST_STATE_PATH = "Tasker/Tesla/Data/TDS_Route_Request_State.json";
const ROUTE_CACHE_TEXT_PATH = "Tasker/Tesla/Data/RouteCache.txt";
const TEMP_CACHE_TEXT_PATH = "Tasker/Tesla/Data/Temp_Route_Cache.txt";
const ORDER_CACHE_TEXT_PATH = "Tasker/Tesla/Data/TDS_Order_Cache.txt";
// Exact-key membership (never substring): the manager is the only permitted owner.
const CACHE_FILES = [ROUTE_CACHE_PATH, ORDER_CACHE_PATH, TEMP_CACHE_PATH, REQUEST_STATE_PATH,
  ROUTE_CACHE_TEXT_PATH, TEMP_CACHE_TEXT_PATH, ORDER_CACHE_TEXT_PATH];

function createSandbox(options) {
  options = options || {};
  // FU1 (REQ-6FU-1): serialMode models the production Tasker serial chain —
  // no reducer/handler/publish function shims are injected, so scripts that
  // stage commands (Sandbox stageReducerCommand, adapters) accumulate staged
  // par1/par2 instead of applying synchronously. The stateCommand shim then
  // runs the staged owner script after the router, exactly like the serial
  // task: ONE TDS_State_Command invocation delivers the whole REDUCER_BATCH.
  const serialMode = options.serialMode === true;
  const initialLocals = options.locals || {};
  const initialGlobals = options.globals || {};
  const initialFiles = options.files || {};
  const initialNowMs = (typeof options.nowMs === "number") ? options.nowMs : Date.now();

  const liveLocals = {};
  Object.keys(initialLocals).forEach(function (k) {
    liveLocals[k] = stringify(initialLocals[k]);
  });

  const liveGlobals = {};
  Object.keys(initialGlobals).forEach(function (k) {
    liveGlobals[k] = stringify(initialGlobals[k]);
  });

  const liveFiles = {};
  Object.keys(initialFiles).forEach(function (k) {
    liveFiles[k] = stringify(initialFiles[k]);
  });

  const flashLog = [];
  const writeLog = [];
  const writeOrder = [];
  const deleteOrder = [];
  const failures = options.failures || {};
  const writeThrows = failures.writeThrows || [];
  // One-shot torn-write model: a torn write is a single fault event (power
  // loss mid-write). The matching path pattern fires once, then heals so a
  // retry/restore write succeeds — faithful to the rollback contract.
  const tornWrites = (failures.tornWrites || []).slice();
  let now = initialNowMs;

  function publish(candidate) {
    setLocal('par1', JSON.stringify(candidate));
    // Identify the Generation Publisher so its reorder-queue drain/clear passes
    // the ownership guard (State Command enqueues; Publisher drains and clears).
    sandbox.__currentScriptPath = PUBLISHER_PATH;
    runScript(PUBLISHER_PATH, sandbox, store);
    sandbox.__currentScriptPath = '';
    return local('return_value');
  }

  function reducer(command, payload, context) {
    const outer = sandbox.__currentScriptPath;
    setLocal('par1', command);
    setLocal('par2', JSON.stringify(payload));
    if (context !== undefined) setLocal('par3', JSON.stringify(context));
    sandbox.__currentScriptPath = REDUCER_PATH;
    runScript(REDUCER_PATH, sandbox, store);
    sandbox.__currentScriptPath = outer;
    return local('return_value');
  }

  // handler(op, payload): runs the Override Handler through its own staged
  // command entry (par1 op / par2 JSON payload) with __currentScriptPath set so
  // its OVR/PREFS writes pass the ownership guard. Mirrors reducer().
  function handler(command, payload) {
    const outer = sandbox.__currentScriptPath;
    setLocal('par1', command);
    setLocal('par2', JSON.stringify(payload));
    sandbox.__currentScriptPath = OVERRIDE_HANDLER_PATH;
    runScript(OVERRIDE_HANDLER_PATH, sandbox, store);
    sandbox.__currentScriptPath = outer;
    return local('return_value');
  }

  // stateCommand(command, payload): runs the TDS_State_Command router through
  // its staged entry (par1 command / par2 JSON payload) with __currentScriptPath
  // set so its TDS_Reorder_Commands.json append passes the ownership guard.
  // Mirrors reducer()/handler(). In serialMode the owner shims are absent, so
  // after the router declares an owner the staged owner script runs next — the
  // serial Tasker task parity that lets ONE router invocation deliver a whole
  // REDUCER_BATCH (REQ-6FU-1, SCN-6FU-2).
  function stateCommand(command, payload) {
    setLocal('par1', command);
    setLocal('par2', JSON.stringify(payload));
    sandbox.__currentScriptPath = STATE_COMMAND_PATH;
    runScript(STATE_COMMAND_PATH, sandbox, store);
    if (serialMode) {
      const owner = local('tds_state_owner');
      if (owner === 'Trip_State_Reducer') {
        sandbox.__currentScriptPath = REDUCER_PATH;
        runScript(REDUCER_PATH, sandbox, store);
      } else if (owner === 'Override_Handler') {
        sandbox.__currentScriptPath = OVERRIDE_HANDLER_PATH;
        runScript(OVERRIDE_HANDLER_PATH, sandbox, store);
      } else if (owner === 'Generation_Publisher') {
        sandbox.__currentScriptPath = PUBLISHER_PATH;
        runScript(PUBLISHER_PATH, sandbox, store);
      }
    }
    sandbox.__currentScriptPath = '';
    return local('return_value');
  }

  // cacheManager(command, payload): runs Route_Cache_Manager through its staged
  // entry (par1 command / par2 JSON payload) with __currentScriptPath set so its
  // four cache JSON files + legacy text projections pass the ownership guard.
  // Mirrors reducer()/handler()/stateCommand().
  function cacheManager(command, payload) {
    const outer = sandbox.__currentScriptPath;
    setLocal('par1', command);
    setLocal('par2', JSON.stringify(payload));
    sandbox.__currentScriptPath = CACHE_MANAGER_PATH;
    runScript(CACHE_MANAGER_PATH, sandbox, store);
    sandbox.__currentScriptPath = outer;
    return local('return_value');
  }

  function local(key) {
    return Object.prototype.hasOwnProperty.call(liveLocals, key) ? liveLocals[key] : "";
  }
  function setLocal(key, value) {
    liveLocals[key] = stringify(value);
  }
  function globalFn(key) {
    return Object.prototype.hasOwnProperty.call(liveGlobals, key) ? liveGlobals[key] : "";
  }
  function setGlobal(key, value) {
    liveGlobals[key] = stringify(value);
  }
  function readFile(path) {
    // Faithful to the Tasker runtime: missing files return null, present
    // files return their exact bytes (including "" for an empty present
    // file). Tests that need to distinguish must check against null.
    return Object.prototype.hasOwnProperty.call(liveFiles, path) ? liveFiles[path] : null;
  }
  function matchesAny(path, patterns) {
    for (let i = 0; i < patterns.length; i++) {
      if (path.indexOf(patterns[i]) !== -1) return true;
    }
    return false;
  }
  function isCacheFile(path) { return CACHE_FILES.indexOf(path) !== -1; }
  function rejectCacheWrite(op, path) {
    // REQ-5LOG-1: ownership rejection emits structured LOG-17 evidence so
    // tests can assert the event shape, not just the thrown error text.
    const ts = Math.floor(Date.now() / 1000);
    flashLog.push(JSON.stringify({
      timestamp: ts,
      generationId: null,
      component: "Route_Cache_Manager",
      severity: "ERROR",
      code: "CACHE_WRITE_REJECTED",
      tripId: null,
      details: { op: op, path: path, owner: sandbox.__currentScriptPath || "unknown" }
    }));
    throw new Error("CACHE_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
  }
  function writeFile(path, content) {
    if (isCacheFile(path) && sandbox.__currentScriptPath !== CACHE_MANAGER_PATH) {
      rejectCacheWrite("write", path);
    }
    if (path === PHASE3_STATE_PATH && sandbox.__currentScriptPath !== REDUCER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if ((path === OVERRIDE_PATH || path === PREFS_PATH) && sandbox.__currentScriptPath !== OVERRIDE_HANDLER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if (path === REORDER_QUEUE_PATH && sandbox.__currentScriptPath !== STATE_COMMAND_PATH && sandbox.__currentScriptPath !== PUBLISHER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if ((path === SESSIONS_PATH || path === MANUAL_TRIPS_PATH || path === ACTION_LOCK_PATH) && sandbox.__currentScriptPath !== STATE_COMMAND_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if (matchesAny(path, writeThrows)) throw new Error("injected write failure: " + path);
    const s = stringify(content);
    let written = s;
    const tornIdx = tornWrites.findIndex(function (p) { return path.indexOf(p) !== -1; });
    if (tornIdx !== -1) {
      written = s.slice(0, Math.max(0, s.length - 4));
      tornWrites.splice(tornIdx, 1);
    }
    liveFiles[path] = written;
    writeLog.push({ op: "write", path: path, length: written.length, owner: sandbox.__currentScriptPath || null });
    writeOrder.push(path);
  }
  function deleteFile(path) {
    if (isCacheFile(path) && sandbox.__currentScriptPath !== CACHE_MANAGER_PATH) {
      rejectCacheWrite("delete", path);
    }
    if ((path === OVERRIDE_PATH || path === PREFS_PATH) && sandbox.__currentScriptPath !== OVERRIDE_HANDLER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if (path === REORDER_QUEUE_PATH && sandbox.__currentScriptPath !== STATE_COMMAND_PATH && sandbox.__currentScriptPath !== PUBLISHER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if ((path === SESSIONS_PATH || path === MANUAL_TRIPS_PATH || path === ACTION_LOCK_PATH) && sandbox.__currentScriptPath !== STATE_COMMAND_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    delete liveFiles[path];
    writeLog.push({ op: "delete", path: path, owner: sandbox.__currentScriptPath || null });
    deleteOrder.push(path);
  }
  function flash(message) {
    flashLog.push(typeof message === "string" ? message : String(message));
  }

  const RealDate = Date;
  function PinnedDate() {
    if (arguments.length === 0) {
      return new RealDate(now);
    }
    switch (arguments.length) {
      case 1: return new RealDate(arguments[0]);
      case 2: return new RealDate(arguments[0], arguments[1]);
      case 3: return new RealDate(arguments[0], arguments[1], arguments[2]);
      case 4: return new RealDate(arguments[0], arguments[1], arguments[2], arguments[3]);
      case 5: return new RealDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
      case 6: return new RealDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5]);
      default: return new RealDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6]);
    }
  }
  PinnedDate.now = function () { return now; };
  PinnedDate.parse = RealDate.parse;
  PinnedDate.UTC = RealDate.UTC;
  PinnedDate.prototype = RealDate.prototype;

  const sandbox = {
    local: local,
    setLocal: setLocal,
    global: globalFn,
    setGlobal: setGlobal,
    readFile: readFile,
    writeFile: writeFile,
    deleteFile: deleteFile,
    flash: flash,
    Date: PinnedDate,
    Math: Object.assign(Object.create(Math), { random: Math.random }),
    JSON: JSON,
    console: console,
    Number: Number,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    Object: Object,
    Array: Array,
    String: String,
    Boolean: Boolean,
    __currentScriptPath: '',
    publish: serialMode ? undefined : publish,
    reducer: serialMode ? undefined : reducer,
    handler: serialMode ? undefined : handler,
    stateCommand: stateCommand,
    cacheManager: cacheManager
  };

  const store = {
    locals: liveLocals,
    globals: liveGlobals,
    files: liveFiles,
    flashLog: flashLog,
    writeLog: writeLog,
    writeOrder: writeOrder,
    deleteOrder: deleteOrder,
    get now() { return now; },
    set now(v) { now = v; }
  };

  return { sandbox: sandbox, store: store };
}

// Phase 5 (REQ-5QUEUE-1): typed queue envelope builders for Compiler/Sandbox
// harnesses. Tasker Variable Split never processes block_queue; the Compiler
// JSON.parses the envelope once inside its JSlet.
function makeEnvelope(rows, opts) {
  opts = opts || {};
  return JSON.stringify({
    schemaVersion: 1,
    rows: rows || [],
    eof: opts.eof || false,
    skipIdxUntil: (typeof opts.skipIdxUntil === 'number') ? opts.skipIdxUntil : 0,
    stepConflict: opts.stepConflict || null,
    notifications: opts.notifications || []
  });
}

// Build a TypedRow object; missing fields take contract defaults so harnesses
// only spell out the fields their scenario cares about.
function makeTypedRow(fields) {
  return Object.assign({
    rowType: '', title: '', coords: '', mode: '', displayTime: 0, departTime: 0,
    pitstopState: '', apiTimeType: '', apiTimeUnix: 0, evId: '', evLoc: '',
    engineLateMins: 0, currentLegStable: false, dropinStatusFlag: '', safeDesc: '',
    adHoc: [], routeDurationSecs: null, routeDistanceMiles: null,
    departurePolicy: 'JIT', planningDay: '', originSource: ''
  }, fields);
}

function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  return String(value);
}

module.exports = { createSandbox: createSandbox, makeEnvelope: makeEnvelope, makeTypedRow: makeTypedRow };
