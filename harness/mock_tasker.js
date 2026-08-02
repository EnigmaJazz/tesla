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
//   store.writeLog   - every writeFile and deleteFile call with op/path/length.
//   store.writeOrder - ordered list of paths passed to writeFile.
//   store.deleteOrder- ordered list of paths passed to deleteFile.

const path = require('node:path');
const { runScript } = require('./runner');

const PUBLISHER_PATH = path.resolve(__dirname, '..', 'Generation_Publisher.js');
const REDUCER_PATH = path.resolve(__dirname, '..', 'Trip_State_Reducer.js');
const OVERRIDE_HANDLER_PATH = path.resolve(__dirname, '..', 'Override_Handler.js');
const PHASE3_STATE_PATH = "Tasker/Tesla/Data/TDS_Trip_State.json";
const OVERRIDE_PATH = "Tasker/Tesla/Data/TDS_Overrides.json";
const PREFS_PATH = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";

function createSandbox(options) {
  options = options || {};
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
    runScript(PUBLISHER_PATH, sandbox, store);
    return local('return_value');
  }

  function reducer(command, payload, context) {
    setLocal('par1', command);
    setLocal('par2', JSON.stringify(payload));
    if (context !== undefined) setLocal('par3', JSON.stringify(context));
    sandbox.__currentScriptPath = REDUCER_PATH;
    runScript(REDUCER_PATH, sandbox, store);
    sandbox.__currentScriptPath = '';
    return local('return_value');
  }

  // handler(op, payload): runs the Override Handler through its own staged
  // command entry (par1 op / par2 JSON payload) with __currentScriptPath set so
  // its OVR/PREFS writes pass the ownership guard. Mirrors reducer().
  function handler(command, payload) {
    setLocal('par1', command);
    setLocal('par2', JSON.stringify(payload));
    sandbox.__currentScriptPath = OVERRIDE_HANDLER_PATH;
    runScript(OVERRIDE_HANDLER_PATH, sandbox, store);
    sandbox.__currentScriptPath = '';
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
    return Object.prototype.hasOwnProperty.call(liveFiles, path) ? liveFiles[path] : "";
  }
  function matchesAny(path, patterns) {
    for (let i = 0; i < patterns.length; i++) {
      if (path.indexOf(patterns[i]) !== -1) return true;
    }
    return false;
  }
  function writeFile(path, content) {
    if (path === PHASE3_STATE_PATH && sandbox.__currentScriptPath !== REDUCER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    if ((path === OVERRIDE_PATH || path === PREFS_PATH) && sandbox.__currentScriptPath !== OVERRIDE_HANDLER_PATH) {
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
    writeLog.push({ op: "write", path: path, length: written.length });
    writeOrder.push(path);
  }
  function deleteFile(path) {
    if ((path === OVERRIDE_PATH || path === PREFS_PATH) && sandbox.__currentScriptPath !== OVERRIDE_HANDLER_PATH) {
      throw new Error("UNAUTHORIZED_WRITE_REJECTED: " + path + " by " + (sandbox.__currentScriptPath || "unknown"));
    }
    delete liveFiles[path];
    writeLog.push({ op: "delete", path: path });
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
    publish: publish,
    reducer: reducer,
    handler: handler
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

function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  return String(value);
}

module.exports = { createSandbox: createSandbox };
