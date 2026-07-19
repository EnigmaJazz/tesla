// Mock Tasker runtime for the test harness.
// Tasker scripts call local(key), setLocal(key, value), global(key), setGlobal,
// readFile(path), writeFile(path, content), flash(message), Date.now() and
// use built-ins like Math, JSON, parseInt, isNaN. This module builds a vm
// sandbox that mimics the runtime and exposes a live store the test can
// inspect after the script has run.

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
  let now = initialNowMs;

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
  function writeFile(path, content) {
    liveFiles[path] = stringify(content);
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
    flash: flash,
    Date: PinnedDate,
    Math: Math,
    JSON: JSON,
    console: console,
    Number: Number,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    Object: Object,
    Array: Array,
    String: String,
    Boolean: Boolean
  };

  const store = {
    locals: liveLocals,
    globals: liveGlobals,
    files: liveFiles,
    flashLog: flashLog,
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
