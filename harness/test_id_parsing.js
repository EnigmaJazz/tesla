// ID-2: Strict occurrence-ID parsing at the parser and consumer sites.
//
// Occurrence IDs are `<coreId>_<base36StartUnix>`. The core MAY contain
// underscores (Google Calendar IDs can), so the split uses `lastIndexOf("_")`;
// the full string must match `^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$` and the base-36
// suffix must decode to a Unix timestamp in [1e9, 2.5e9). Rejections flash
// structured JSON (LOG-17 fields) with code ID_PARSE_REJECTED and reasons
// empty_id | malformed_format | invalid_suffix; the consumer MUST skip the
// rejected occurrence/command (no apply).
//
// Ported from the slice-4 branch harness to master conventions (mock_tasker
// runner, no Override_Handler yet — that is slice B). The substring-decoy
// fixture asserts parser-level exactness (distinct cores, never conflation);
// membership-level decoy coverage lands with the handler's exact-key maps in
// slice C.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const homeCoords = "51.9,-2.1";
const eventCoords = "52.0,-2.0";
const eventStart = nowSec + 3600;

const VALID_ID = "abc123_kx8f00";
const UNDERSCORE_CORE_ID = "google_abc123_kx8f00"; // core contains "_"; lastIndexOf split
const NO_UNDERSCORE_ID = "abcdef";
const INVALID_SUFFIX_ID = "abc_xyz";               // suffix decodes below 1e9
const TRAILING_GARBAGE_ID = "abc123_kx8f00!";      // regex fails
const EMPTY_CORE_ID = "_kx8f00";                   // leading underscore
const EMPTY_ID = "";                               // empty_id
const SUBSTRING_DECOY_ID = "xyzabc123_kx8f00";     // contains VALID_ID as substring

// Bounds fixtures built programmatically so the boundary semantics are exact.
const BELOW_MIN_SUFFIX = (1e9 - 1).toString(36);
const AT_MIN_SUFFIX = (1e9).toString(36);
const BELOW_MAX_SUFFIX = (2.5e9 - 1).toString(36);
const AT_MAX_SUFFIX = (2.5e9).toString(36);

const baseGeocodes = [
  nowSec.toString(),
  (nowSec + 86400).toString(),
  homeCoords,
  "0",
  "Home",
  "",
  "home_base"
].join("~");

function commonFiles(eventId) {
  const masterJson = JSON.stringify([
    {
      id: eventId,
      start: eventStart,
      end: eventStart + 3600,
      duration: 3600,
      title: "Future Event",
      desc: "",
      loc: "Work",
      coords: eventCoords
    }
  ]);
  return {
    "Tasker/Tesla/Data/Itin_Master.json": "[]",
    "Tasker/Tesla/Data/TDS_Master.json": masterJson,
    "Tasker/Tesla/Data/TDS_Base_Geocodes.txt": baseGeocodes,
    "Tasker/Tesla/Data/TDS_Overrides.json": "{}",
    "Tasker/Tesla/Data/Temp_Route_Cache.txt": "",
    "Tasker/Tesla/Data/RouteCache.txt": ""
  };
}

const commonGlobals = {
  User_At_Base: "true",
  Base_Arrival_Unix: nowSec.toString(),
  User_Loc: homeCoords,
  Home_Coords: homeCoords,
  Current_Status: "",
  Arrival_Buffer_Mins: "5",
  Departure_Buffer_Mins: "5",
  Max_Walk_Meters: "8046",
  Daily_Walk_Meters: "0",
  Live_Traffic_Threshold: "7200",
  Car_Connected: "false"
};

const commonLocals = {
  idx: "1",
  vcar_loc: homeCoords,
  virtual_time: String(nowSec),
  virtual_loc: homeCoords
};

const sandboxPath = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
const injectorPath = path.resolve(__dirname, '..', 'Override_Injector.js');
const appenderPath = path.resolve(__dirname, '..', 'Appender.js');
const idParserPath = path.resolve(__dirname, '..', 'ID_Parser.js');

const OVR_PATH = "Tasker/Tesla/Data/TDS_Overrides.json";

function runCanonical() {
  const { sandbox, store } = createSandbox({ nowMs: nowSec * 1000 });
  runScript(idParserPath, sandbox, store);
  return { sandbox: sandbox, store: store };
}

function runSandbox(eventId) {
  const { sandbox, store } = createSandbox({
    locals: Object.assign({}, commonLocals),
    globals: Object.assign({}, commonGlobals),
    files: commonFiles(eventId),
    nowMs: nowSec * 1000
  });
  runScript(sandboxPath, sandbox, store);
  return store;
}

function runInjector(targetId, overrideKey, ovrSeed) {
  const itinJson = JSON.stringify([
    {
      tripId: "test_leg",
      targetEventId: targetId,
      mode: "DRIVE",
      targetCoords: eventCoords
    }
  ]);
  const { sandbox, store } = createSandbox({
    locals: { par1: "0", par2: overrideKey },
    globals: { User_Loc: homeCoords },
    files: {
      "Tasker/Tesla/Data/Itin_Master.json": itinJson,
      [OVR_PATH]: ovrSeed || "{}"
    },
    nowMs: nowSec * 1000
  });
  runScript(injectorPath, sandbox, store);
  return consumeStaged(store);
}

// D2: manifest-backed variant — seeds a committed TDS_Run_Manifest.json plus
// the committed generation's Itin_Master file, so the injector resolves the
// itinerary through the canonical manifest resolver instead of the legacy
// Itin_Master.json fallback.
function runInjectorManifest(targetId, overrideKey) {
  const gen = "gen:" + nowSec + ":abcd";
  const genEnc = gen.replace(/:/g, "_");
  const genItinPath = "Tasker/Tesla/Data/Itin_Master." + genEnc + ".json";
  const itinGen = JSON.stringify([
    {
      tripId: "test_leg",
      targetEventId: targetId,
      mode: "DRIVE",
      targetCoords: eventCoords
    }
  ]);
  const { sandbox, store } = createSandbox({
    locals: { par1: "0", par2: overrideKey },
    globals: { User_Loc: homeCoords },
    files: {
      "Tasker/Tesla/Data/TDS_Run_Manifest.json": JSON.stringify({
        state: "committed",
        activeGeneration: gen,
        itineraryPath: genItinPath
      }),
      [genItinPath]: itinGen,
      [OVR_PATH]: "{}"
    },
    nowMs: nowSec * 1000
  });
  runScript(injectorPath, sandbox, store);
  return consumeStaged(store);
}

function runAppender(eventId, ovrSeed) {
  const routeSig = homeCoords + "^" + eventCoords;
  const finalReturn = "DRIVE|" + eventId + "|" + routeSig;
  const { sandbox, store } = createSandbox({
    locals: { final_return: finalReturn },
    globals: {},
    files: { [OVR_PATH]: ovrSeed || "{}" },
    nowMs: nowSec * 1000
  });
  runScript(appenderPath, sandbox, store);
  return consumeStaged(store);
}

function readOvr(store) {
  const raw = store.files[OVR_PATH] || "{}";
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// D2 (RULE-8C): Adapters stage commands (par1/par2) instead of writing OVR
// directly. Consume a staged Override Handler command by running the handler
// against the same files so the mutation lands in the committed store.
function consumeStaged(store) {
  const par1 = store.locals.par1;
  const knownCommands = ["APPLY_OVERRIDE", "APPEND_OVERRIDE", "SET_DEFAULT", "PRUNE"];
  if (knownCommands.indexOf(par1) === -1) return store;
  const { sandbox, store: handlerStore } = createSandbox({
    globals: {},
    files: store.files,
    nowMs: nowSec * 1000
  });
  // F1: consume through the mock handler() shim so __currentScriptPath
  // identifies the Override Handler and its OVR/PREFS writes pass the guard.
  sandbox.handler(par1, JSON.parse(store.locals.par2));
  return handlerStore;
}

// Asserts the full LOG-17 structured shape of an ID_PARSE_REJECTED flash.
function idParseRejectedShape(store, reason, component, rawId) {
  return store.flashLog.some(function (m) {
    try {
      const parsed = JSON.parse(m);
      return parsed.code === 'ID_PARSE_REJECTED'
        && parsed.severity === 'WARN'
        && parsed.tripId === null
        && parsed.generationId === null
        && typeof parsed.timestamp === 'number'
        && (component === undefined || parsed.component === component)
        && parsed.details !== null
        && typeof parsed.details === 'object'
        && parsed.details.reason === reason
        && (rawId === undefined || parsed.details.rawId === rawId);
    } catch (e) {
      return false;
    }
  });
}

function idParseRejected(store, reason) {
  return idParseRejectedShape(store, reason);
}

function fail(msg) {
  console.log('FAIL: ID Parsing — ' + msg);
  process.exit(1);
}

// ---------- Canonical ID_Parser.js ----------

try {
  const { sandbox, store } = runCanonical();
  const parse = function (id) { return sandbox.parseOccurrenceId(id, "ID_Parser"); };

  // Valid IDs, including underscore-core lastIndexOf split.
  const valid = parse(VALID_ID);
  if (!valid.ok) fail('VALID_ID should parse ok');
  assert.equal(valid.coreId, "abc123", 'VALID_ID core');
  assert.equal(valid.instanceStartUnix, 1265143536, 'VALID_ID suffix is kx8f00 base-36');
  assert.equal(valid.rawId, VALID_ID, 'VALID_ID rawId echo');

  const underscoreCore = parse(UNDERSCORE_CORE_ID);
  if (!underscoreCore.ok) fail('UNDERSCORE_CORE_ID should parse ok');
  assert.equal(underscoreCore.coreId, "google_abc123", 'core with underscores split at lastIndexOf("_")');
  assert.equal(underscoreCore.instanceStartUnix, 1265143536, 'underscore-core suffix');

  // Bounds: [1e9, 2.5e9) inclusive lower, exclusive upper.
  if (!parse("abc_" + AT_MIN_SUFFIX).ok) fail('suffix exactly 1e9 should be valid');
  if (!parse("abc_" + BELOW_MAX_SUFFIX).ok) fail('suffix just below 2.5e9 should be valid');
  const belowMin = parse("abc_" + BELOW_MIN_SUFFIX);
  if (belowMin.ok || belowMin.reason !== "invalid_suffix") fail('suffix below 1e9 must reject invalid_suffix');
  const atMax = parse("abc_" + AT_MAX_SUFFIX);
  if (atMax.ok || atMax.reason !== "invalid_suffix") fail('suffix at 2.5e9 must reject invalid_suffix');

  // Substring decoy: parser must never conflate VALID_ID with a longer ID.
  const decoy = parse(SUBSTRING_DECOY_ID);
  if (!decoy.ok) fail('SUBSTRING_DECOY_ID should parse ok');
  assert.equal(decoy.coreId, "xyzabc123", 'decoy core is exact, never truncated to abc123');
  assert.notEqual(decoy.coreId, valid.coreId, 'decoy and valid cores must be distinct');

  // Invalid IDs and their reasons.
  const expectReject = function (id, reason) {
    const r = parse(id);
    if (r.ok || r.reason !== reason) {
      fail(JSON.stringify(id) + ' should reject with ' + reason + ', got ' + JSON.stringify(r));
    }
    if (!idParseRejectedShape(store, reason, "ID_Parser", id)) {
      fail(JSON.stringify(id) + ' missing ID_PARSE_REJECTED shape flash (reason ' + reason + ')');
    }
  };
  expectReject(NO_UNDERSCORE_ID, "malformed_format");
  expectReject(INVALID_SUFFIX_ID, "invalid_suffix");
  expectReject(TRAILING_GARBAGE_ID, "malformed_format");
  expectReject(EMPTY_CORE_ID, "malformed_format");
  expectReject(EMPTY_ID, "empty_id");

  // No stray reject flashes on the valid path.
  if (idParseRejected(store)) fail('valid canonical fixtures should not flash ID_PARSE_REJECTED');
} catch (e) {
  fail('canonical parser section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Sandbox_Engine.js ----------

try {
  const validStore = runSandbox(VALID_ID);
  if (validStore.runError) fail('Sandbox valid ID runError: ' + validStore.runError);
  if (idParseRejected(validStore)) fail('Sandbox valid ID must not flash ID_PARSE_REJECTED');
  const validQueue = validStore.locals.block_queue || "";
  const validEnv = validQueue && validQueue !== "EOF" ? JSON.parse(validQueue) : null;
  const validRows = (validEnv && validEnv.rows) || [];
  if (!validRows.some(function (row) { return row.rowType === "EVENT"; })) {
    fail('Sandbox valid ID must produce an EVENT queue row');
  }
  const eventRow = validRows.find(function (row) { return row.rowType === "EVENT"; });
  if (eventRow.evId !== VALID_ID) fail('Sandbox EVENT row evId must carry the full occurrence ID');

  const invalidCases = [
    { id: NO_UNDERSCORE_ID, reason: "malformed_format" },
    { id: INVALID_SUFFIX_ID, reason: "invalid_suffix" },
    { id: TRAILING_GARBAGE_ID, reason: "malformed_format" },
    { id: EMPTY_CORE_ID, reason: "malformed_format" }
  ];
  invalidCases.forEach(function (c) {
    const store = runSandbox(c.id);
    if (!idParseRejectedShape(store, c.reason, "Sandbox", c.id)) {
      fail('Sandbox ' + JSON.stringify(c.id) + ' missing ID_PARSE_REJECTED shape flash (reason ' + c.reason + ')');
    }
    const q = store.locals.block_queue || "";
    const env = q && q !== "EOF" ? JSON.parse(q) : null;
    if (env && !env.eof && env.rows.some(function (row) { return row.rowType === "EVENT"; })) {
      fail('Sandbox rejected ' + JSON.stringify(c.id) + ' must not produce an EVENT queue row');
    }
  });
} catch (e) {
  fail('Sandbox section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Appender.js ----------

try {
  const validStore = runAppender(VALID_ID);
  if (validStore.runError) fail('Appender valid ID runError: ' + validStore.runError);
  if (idParseRejected(validStore)) fail('Appender valid ID must not flash ID_PARSE_REJECTED');
  if (validStore.locals.par1 !== "APPEND_OVERRIDE") fail('Appender valid ID must stage APPEND_OVERRIDE');
  const validOvr = readOvr(validStore);
  assert.equal(validOvr["Forced_Drives"], VALID_ID, 'Appender valid ID must apply the override');
  // D2 (RULE-8C): the override lands through the staged command, so the
  // schema-v2 eventOverrides map carries the mode (not just the projection).
  if (!validOvr.eventOverrides || !validOvr.eventOverrides[VALID_ID] || validOvr.eventOverrides[VALID_ID].mode !== "drive") {
    fail('Appender valid ID must consume the staged command into eventOverrides');
  }
  const appRv = validStore.locals.return_value || "";
  if (appRv.indexOf('"ok":true') === -1) fail('Appender staged command must return ok: ' + appRv);

  const invalidCases = [
    { id: NO_UNDERSCORE_ID, reason: "malformed_format" },
    { id: TRAILING_GARBAGE_ID, reason: "malformed_format" },
    { id: EMPTY_ID, reason: "empty_id" }
  ];
  invalidCases.forEach(function (c) {
    const store = runAppender(c.id);
    if (!idParseRejectedShape(store, c.reason, "Appender", c.id)) {
      fail('Appender ' + JSON.stringify(c.id) + ' missing ID_PARSE_REJECTED shape flash (reason ' + c.reason + ')');
    }
    if (store.locals.par1 === "APPEND_OVERRIDE") {
      fail('Appender rejected ' + JSON.stringify(c.id) + ' must not stage a command');
    }
    const ovr = readOvr(store);
    if ((ovr["Forced_Drives"] || "").length > 0) {
      fail('Appender rejected ' + JSON.stringify(c.id) + ' must not persist the ID');
    }
  });
} catch (e) {
  fail('Appender section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Override_Injector.js ----------

try {
  const validStore = runInjector(VALID_ID, "Forced_Drives");
  if (validStore.runError) fail('Injector valid ID runError: ' + validStore.runError);
  if (idParseRejected(validStore)) fail('Injector valid ID must not flash ID_PARSE_REJECTED');
  if (validStore.locals.par1 !== "APPLY_OVERRIDE") fail('Injector valid ID must stage APPLY_OVERRIDE');
  const validOvr = readOvr(validStore);
  assert.equal(validOvr["Forced_Drives"], VALID_ID, 'Injector valid ID must apply the override');
  // D2 (RULE-8C): the override lands through the staged command, so the
  // schema-v2 eventOverrides map carries the mode (not just the projection).
  if (!validOvr.eventOverrides || !validOvr.eventOverrides[VALID_ID] || validOvr.eventOverrides[VALID_ID].mode !== "drive") {
    fail('Injector valid ID must consume the staged command into eventOverrides');
  }
  const injRv = validStore.locals.return_value || "";
  if (injRv.indexOf('"ok":true') === -1) fail('Injector staged command must return ok: ' + injRv);

  const invalidCases = [
    { id: NO_UNDERSCORE_ID, reason: "malformed_format" },
    { id: INVALID_SUFFIX_ID, reason: "invalid_suffix" },
    { id: TRAILING_GARBAGE_ID, reason: "malformed_format" }
  ];
  invalidCases.forEach(function (c) {
    const store = runInjector(c.id, "Forced_Drives");
    if (!idParseRejectedShape(store, c.reason, "Override_Injector", c.id)) {
      fail('Injector ' + JSON.stringify(c.id) + ' missing ID_PARSE_REJECTED shape flash (reason ' + c.reason + ')');
    }
    if (store.locals.par1 === "APPLY_OVERRIDE") {
      fail('Injector rejected ' + JSON.stringify(c.id) + ' must not stage a command');
    }
    const ovr = readOvr(store);
    if ((ovr["Forced_Drives"] || "").length > 0) {
      fail('Injector rejected ' + JSON.stringify(c.id) + ' must not persist the ID');
    }
  });
} catch (e) {
  fail('Injector section threw: ' + (e && e.message ? e.message : e));
}

// D2 (RULE-8C): manifest-backed injector — the committed itinerary resolves
// through the manifest resolver (TDS_Run_Manifest.json + generation file),
// not only the legacy Itin_Master.json fallback.
try {
  const mStore = runInjectorManifest(VALID_ID, "Forced_Drives");
  if (mStore.runError) fail('Injector manifest-backed runError: ' + mStore.runError);
  if (idParseRejected(mStore)) fail('Injector manifest-backed must not flash ID_PARSE_REJECTED');
  if (mStore.locals.par1 !== "APPLY_OVERRIDE") fail('Injector manifest-backed must stage APPLY_OVERRIDE');
  const mOvr = readOvr(mStore);
  assert.equal(mOvr["Forced_Drives"], VALID_ID, 'Injector manifest-backed must apply the override');
  if (!mOvr.eventOverrides || !mOvr.eventOverrides[VALID_ID] || mOvr.eventOverrides[VALID_ID].mode !== "drive") {
    fail('Injector manifest-backed must consume the staged command into eventOverrides');
  }
  const mRv = mStore.locals.return_value || "";
  if (mRv.indexOf('"ok":true') === -1) fail('Injector manifest-backed command must return ok: ' + mRv);
} catch (e) {
  fail('Injector manifest-backed section threw: ' + (e && e.message ? e.message : e));
}

// --- D2: Default Manager (SET_DEFAULT staging) -----------------------------
const defaultPath = path.resolve(__dirname, '..', 'Default.js');
const PREFS_PATH = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";

function runDefault(fullCmd, ovrSeed) {
  const { sandbox, store } = createSandbox({
    locals: { command_text: fullCmd },
    globals: {},
    files: { [OVR_PATH]: ovrSeed || "{}" },
    nowMs: nowSec * 1000
  });
  runScript(defaultPath, sandbox, store);
  return consumeStaged(store);
}

function readPrefs(store) {
  const raw = store.files[PREFS_PATH] || "{}";
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

try {
  const dRouteSig = homeCoords + "^" + eventCoords;
  const dKey = VALID_ID + "^" + dRouteSig + "^DRIVE";

  // SET DEFAULT: the staged SET_DEFAULT lands in schema-v2 seriesPreferences
  // (stored in the prefs file) and mirrors into its Route_Defaults projection.
  const setStore = runDefault("TDS_SET_DEFAULT|" + dKey);
  if (setStore.runError) fail('Default set runError: ' + setStore.runError);
  if (setStore.locals.par1 !== "SET_DEFAULT") fail('Default set must stage SET_DEFAULT');
  const setPrefs = readPrefs(setStore);
  if (!setPrefs.seriesPreferences || !setPrefs.seriesPreferences[VALID_ID] || !setPrefs.seriesPreferences[VALID_ID][dRouteSig] || !setPrefs.seriesPreferences[VALID_ID][dRouteSig].defaults["DRIVE"]) {
    fail('Default set must land in seriesPreferences defaults');
  }
  if ((setPrefs["Route_Defaults"] || "").indexOf(dKey) === -1) {
    fail('Default set must mirror into the Route_Defaults projection');
  }
  if (setStore.locals.cancel_id !== VALID_ID) fail('Default set must export cancel_id');
  const setRv = setStore.locals.return_value || "";
  if (setRv.indexOf('"ok":true') === -1) fail('Default set must return ok: ' + setRv);

  // WIPE ALL: clears every default and history entry.
  const wipeStore = runDefault("TDS_CLEAR_DEFAULT|ALL", "{}");
  if (wipeStore.runError) fail('Default clearAll runError: ' + wipeStore.runError);
  if (wipeStore.locals.par1 !== "SET_DEFAULT") fail('Default clearAll must stage SET_DEFAULT');
  const wipePrefs = readPrefs(wipeStore);
  if ((wipePrefs["Route_Defaults"] || "") !== "") fail('Default clearAll must clear Route_Defaults projection');
  if ((wipePrefs["Route_History"] || "") !== "") fail('Default clearAll must clear Route_History projection');
  const wipeRv = wipeStore.locals.return_value || "";
  if (wipeRv.indexOf('"ok":true') === -1) fail('Default clearAll must return ok: ' + wipeRv);
} catch (e) {
  fail('Default section threw: ' + (e && e.message ? e.message : e));
}

console.log('PASS: ID Parsing — canonical parser, bounds, malformed, rejection-log shape, and three consumer skip-on-reject sites');
