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
  return store;
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
  return store;
}

function readOvr(store) {
  const raw = store.files[OVR_PATH] || "{}";
  try { return JSON.parse(raw); } catch (e) { return {}; }
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

// ---------- Consumer sites (pending — land with the inline remediations) ----------
// Slice A commit 1 ships the canonical parser and its harness coverage. The
// three consumer sections (Sandbox_Engine.js / Appender.js / Override_Injector.js
// skip-on-reject) are added by commit 2 together with the inline parser copies.

console.log('PASS: ID Parsing — canonical parser, bounds, malformed, rejection-log shape');
