// RULE-8C / OVR-10: Override resource single-writer, protected preference
// migration, and the four serialized override operations (Slice B + C).
//
// Override Handler is the sole writer for TDS_Overrides.json and
// TDS_Routine_Preferences.json. This suite covers:
//
//   Shell dispatch       — PRUNE/unknown/missing command routing.
//   Exact-key helpers    — exact membership, never substring matching.
//   Successful migration — legacy Route_Defaults/Route_History move once
//                          from OVR into PREFS; other projections survive.
//   One-time migration   — a second Handler use must NOT re-add keys to OVR.
//   Failed-write rollback— injected write failure preserves both resources.
//   Torn-write rollback  — torn preference write returns prior state.
//   APPLY_OVERRIDE       — exact-key toggle, conflicting-category wipe,
//                          substring decoy immunity, invalid-ID rejection.
//   APPEND_OVERRIDE      — append + alsoAppendLate, invalid-ID rejection.
//   SET_DEFAULT          — set/wipe/clearAll against seriesPreferences.
//   PRUNE                — whitelist survival, 24h retention, 12h future
//                          exclusion, four-hour Depart window, and global
//                          memory CSV pruning.
//   Propose-default      — third categorized occurrence proposes a default.
//   Projection sync      — eventOverrides map and CSV projections agree.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const OVR_FILE = "Tasker/Tesla/Data/TDS_Overrides.json";
const PREFS_FILE = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";
const HANDLER_PATH = path.resolve(__dirname, '..', 'Override_Handler.js');

// Base-36 occurrence IDs (suffix = base-36 Unix seconds).
const ID_RECENT = "abc123_s44tm8";      // now - 1h  → inside 24h retention
const ID_STALE = "abc123_s41728";       // now - 48h → outside retention
const ID_FUTURE_OK = "abc123_s44z68";   // now + 1h  → inside 12h exclusion
const ID_FUTURE_FAR = "abc123_s45wi8";  // now + 13h → outside exclusion
const ID_DEPART_OK = "abc123_s451y8";   // now + 2h  → inside 4h Depart window
const ID_DEPART_FAR = "abc123_s45aa8";  // now + 5h  → outside Depart window
const ID_DECOY = "xyzabc123_s44tm8";    // contains ID_RECENT as substring
const ID_WHITELIST = "abc123_kx8f00";   // 2010-era, stale — whitelist only

let failures = 0;
function fail(msg) {
  failures += 1;
  console.log('FAIL: Override Single Writer — ' + msg);
}

function runHandler(files, op, payload, failureOpts, globals) {
  const locals = { par1: op, par2: JSON.stringify(payload) };
  const { sandbox, store } = createSandbox({
    locals: locals,
    files: files,
    globals: globals || {},
    nowMs: nowSec * 1000,
    failures: failureOpts || {}
  });
  runScript(HANDLER_PATH, sandbox, store);
  return { sandbox: sandbox, store: store, result: sandbox.local('return_value') };
}

function readJsonStore(store, filePath) {
  const raw = store.files[filePath] || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function ovrOf(store) { return readJsonStore(store, OVR_FILE); }
function prefsOf(store) { return readJsonStore(store, PREFS_FILE); }

// ---------- Shell dispatch ----------

try {
  const empty = runHandler({}, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  if (empty.store.runError) fail('shell runError: ' + JSON.stringify(empty.store.runError));
  const parsed = JSON.parse(empty.result);
  assert.equal(parsed.ok, true, 'PRUNE on empty stores must succeed');
  assert.equal(parsed.action, "pruned", 'PRUNE must report action pruned');

  const unknown = runHandler({}, "NOT_A_COMMAND", {});
  const unknownParsed = JSON.parse(unknown.result);
  assert.equal(unknownParsed.ok, false, 'unknown op must be rejected');
  assert.equal(unknownParsed.reason, "unknown_op: NOT_A_COMMAND", 'unknown op reason must name the op');

  const missing = runHandler({}, "", {});
  assert(missing.result.indexOf('ERROR:') === 0, 'missing command must return ERROR');
} catch (e) {
  fail('shell dispatch section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Exact-key helpers ----------

try {
  const csv = "abc123_kx8f00,xyzabc123_kx8f00,other_zzzzzz";
  const removed = require('node:vm').runInNewContext(
    '(function (csv, target) {' +
    '  var items = (csv || "").split(",");' +
    '  var map = {};' +
    '  for (var i = 0; i < items.length; i++) { var k = items[i].trim(); if (k) map[k] = true; }' +
    '  if (Object.prototype.hasOwnProperty.call(map, target)) { delete map[target]; return Object.keys(map).join(","); }' +
    '  return csv || "";' +
    '})',
    {}
  )(csv, "abc123_kx8f00");
  assert.equal(removed, "xyzabc123_kx8f00,other_zzzzzz", 'exactKeyRemove must drop only the exact key (substring decoy stays)');

  const untouched = require('node:vm').runInNewContext(
    '(function (csv, target) {' +
    '  var items = (csv || "").split(",");' +
    '  var map = {};' +
    '  for (var i = 0; i < items.length; i++) { var k = items[i].trim(); if (k) map[k] = true; }' +
    '  if (Object.prototype.hasOwnProperty.call(map, target)) { delete map[target]; return Object.keys(map).join(","); }' +
    '  return csv || "";' +
    '})',
    {}
  )(csv, "abc123_kx8f0"); // substring of a real member, not an exact key
  assert.equal(untouched, csv, 'exactKeyRemove must not touch substring matches');
} catch (e) {
  fail('exact-key helper section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Successful migration ----------

function legacyFiles(ovrExtra) {
  const ovr = { schemaVersion: 1 };
  ovr["Route_Defaults"] = "routeA^MODE=1,routeB^MODE=2";
  ovr["Route_History"] = "routeA^3";
  ovr["Forced_Drives"] = ID_RECENT;
  Object.keys(ovrExtra || {}).forEach(function (k) { ovr[k] = ovrExtra[k]; });
  return { [OVR_FILE]: JSON.stringify(ovr) };
}

try {
  const files = legacyFiles();
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  if (r.store.runError) fail('migration runError: ' + JSON.stringify(r.store.runError));

  const prefs = prefsOf(r.store);
  assert(prefs, 'PREFS must exist after migration');
  assert.equal(prefs["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'PREFS must contain Route_Defaults value');
  assert.equal(prefs["Route_History"], "routeA^3", 'PREFS must contain Route_History value');
  assert.equal(prefs.schemaVersion, 2, 'PREFS must be schema-v2');

  const ovr = ovrOf(r.store);
  assert(ovr, 'OVR must exist after migration');
  assert.equal(ovr.schemaVersion, 2, 'OVR must be schema-v2');
  assert.equal(Object.prototype.hasOwnProperty.call(ovr, "Route_Defaults"), false, 'OVR must not retain Route_Defaults');
  assert.equal(Object.prototype.hasOwnProperty.call(ovr, "Route_History"), false, 'OVR must not retain Route_History');
  assert.equal(ovr["Forced_Drives"], ID_RECENT, 'non-preference projections must survive migration');

  // One-time: a second Handler use must not re-add keys to overrides.
  const r2 = runHandler(r.store.files, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  const ovr2 = ovrOf(r2.store);
  assert.equal(Object.prototype.hasOwnProperty.call(ovr2, "Route_Defaults"), false, 'second use must not re-add Route_Defaults to OVR');
  const prefs2 = prefsOf(r2.store);
  assert.equal(prefs2["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'second use must preserve migrated preferences');
} catch (e) {
  fail('successful migration section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Failed migration rollback (write throws) ----------

try {
  const files = legacyFiles();
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} }, {
    writeThrows: [PREFS_FILE]
  });
  assert(r.result.indexOf('ERROR') !== -1 || (function () { try { return JSON.parse(r.result).ok === false; } catch (e) { return false; } })(),
    'migration failure must surface as an ERROR result, got: ' + r.result);

  // Original bytes must be recoverable — OVR untouched, PREFS absent.
  const ovrAfter = ovrOf(r.store);
  assert.equal(ovrAfter["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'rollback must preserve original OVR bytes');
  assert.equal(ovrAfter["Route_History"], "routeA^3", 'rollback must preserve original OVR Route_History');
  const prefsAfter = prefsOf(r.store);
  assert(prefsAfter === null, 'PREFS must stay absent when its write fails');
} catch (e) {
  fail('failed-write rollback section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Torn-write rollback ----------

try {
  const files = legacyFiles();
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} }, {
    tornWrites: [PREFS_FILE]
  });
  assert(r.result.indexOf('ERROR') !== -1 || (function () { try { return JSON.parse(r.result).ok === false; } catch (e) { return false; } })(),
    'torn preference write must surface as an ERROR result, got: ' + r.result);

  const ovrAfter = ovrOf(r.store);
  assert.equal(ovrAfter["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'torn-write rollback must preserve original OVR bytes');
  const prefsAfter = prefsOf(r.store);
  assert(prefsAfter === null || !Object.prototype.hasOwnProperty.call(prefsAfter, "Route_Defaults"),
    'no partial authoritative state: PREFS must not contain migrated Route_Defaults after failure');
} catch (e) {
  fail('torn-write rollback section threw: ' + (e && e.message ? e.message : e));
}

// ---------- APPLY_OVERRIDE ----------

try {
  // Toggle ON: exact key lands in Forced_Drives map + projection.
  const r1 = runHandler({}, "APPLY_OVERRIDE", {
    targetId: ID_RECENT, overrideKey: "Forced_Drives",
    origCoords: "51.9,-2.1", destCoords: "51.5,-2.0", baseCmd: "DRIVE"
  });
  const p1 = JSON.parse(r1.result);
  assert.equal(p1.ok, true, 'APPLY toggle ON must succeed');
  assert.equal(p1.action, "Added", 'first APPLY must Add');
  const ovr1 = ovrOf(r1.store);
  assert.equal(ovr1.eventOverrides[ID_RECENT].mode, "drive", 'eventOverrides map must carry mode drive');
  assert.equal(ovr1["Forced_Drives"], ID_RECENT, 'Forced_Drives projection must carry the exact key');

  // Toggle OFF: exact key removed; map entry deleted when empty.
  const r2 = runHandler(r1.store.files, "APPLY_OVERRIDE", {
    targetId: ID_RECENT, overrideKey: "Forced_Drives"
  });
  const p2 = JSON.parse(r2.result);
  assert.equal(p2.action, "Removed", 'second APPLY must Remove');
  const ovr2 = ovrOf(r2.store);
  assert.equal(Object.prototype.hasOwnProperty.call(ovr2.eventOverrides, ID_RECENT), false, 'empty entry must be deleted');
  assert.equal(ovr2["Forced_Drives"] || "", "", 'projection must clear after removal');

  // Conflicting-category wipe: adding to Forced_Lifts must remove the exact
  // Forced_Drives key for the same occurrence (never substring).
  const r3 = runHandler({}, "APPLY_OVERRIDE", { targetId: ID_RECENT, overrideKey: "Forced_Drives" });
  const r4 = runHandler(r3.store.files, "APPLY_OVERRIDE", { targetId: ID_RECENT, overrideKey: "Forced_Lifts" });
  const ovr4 = ovrOf(r4.store);
  assert.equal(ovr4.eventOverrides[ID_RECENT].mode, "lift", 'conflicting category must switch to lift');
  assert.equal(ovr4["Forced_Drives"] || "", "", 'Forced_Drives projection must be wiped');
  assert.equal(ovr4["Forced_Lifts"], ID_RECENT, 'Forced_Lifts projection must carry the exact key');

  // Substring decoy immunity: a longer ID that contains the target as a
  // substring must never be removed with it.
  const r5 = runHandler({}, "APPLY_OVERRIDE", { targetId: ID_RECENT, overrideKey: "Forced_Drives" });
  const r6 = runHandler(r5.store.files, "APPLY_OVERRIDE", { targetId: ID_DECOY, overrideKey: "Forced_Drives" });
  const r7 = runHandler(r6.store.files, "APPLY_OVERRIDE", { targetId: ID_RECENT, overrideKey: "Forced_Drives" });
  const ovr7 = ovrOf(r7.store);
  assert.equal(Object.prototype.hasOwnProperty.call(ovr7.eventOverrides, ID_RECENT), false, 'toggle OFF must remove only the exact key');
  assert.equal(ovr7.eventOverrides[ID_DECOY].mode, "drive", 'substring decoy must survive untouched');
  assert.equal(ovr7["Forced_Drives"], ID_DECOY, 'projection must keep the decoy');

  // Invalid-ID rejection: no mutation, no crash.
  const rBad = runHandler({}, "APPLY_OVERRIDE", { targetId: "not-a-real-id", overrideKey: "Forced_Drives" });
  const pBad = JSON.parse(rBad.result);
  assert.equal(pBad.ok, false, 'invalid ID must be rejected');
  assert.equal(pBad.reason, "id_parse_rejected", 'invalid ID must name id_parse_rejected');
  assert(ovrOf(rBad.store) === null, 'invalid ID must not create an OVR');
} catch (e) {
  fail('APPLY_OVERRIDE section threw: ' + (e && e.message ? e.message : e));
}

// ---------- APPEND_OVERRIDE ----------

try {
  const r1 = runHandler({}, "APPEND_OVERRIDE", { baseId: ID_RECENT, targetArray: "Skipped_Events" });
  const p1 = JSON.parse(r1.result);
  assert.equal(p1.ok, true, 'APPEND must succeed');
  const ovr1 = ovrOf(r1.store);
  assert.equal(ovr1.eventOverrides[ID_RECENT].skip, true, 'append must set skip');
  assert.equal(ovr1["Skipped_Events"], ID_RECENT, 'Skipped_Events projection must carry the exact key');

  // alsoAppendLate additionally sets Ignored_Lateness.
  const r2 = runHandler(r1.store.files, "APPEND_OVERRIDE", { baseId: ID_RECENT, targetArray: "Skipped_Events", alsoAppendLate: true });
  const ovr2 = ovrOf(r2.store);
  assert.equal(ovr2.eventOverrides[ID_RECENT].skip, true, 're-append must keep skip');
  assert.equal(ovr2.eventOverrides[ID_RECENT].ignoreLateness, true, 'alsoAppendLate must set ignoreLateness');
  assert.equal(ovr2["Ignored_Lateness"], ID_RECENT, 'Ignored_Lateness projection must carry the exact key');

  // Invalid baseId rejected.
  const rBad = runHandler({}, "APPEND_OVERRIDE", { baseId: "nope", targetArray: "Skipped_Events" });
  const pBad = JSON.parse(rBad.result);
  assert.equal(pBad.ok, false, 'invalid baseId must be rejected');
  assert.equal(pBad.reason, "id_parse_rejected", 'invalid baseId must name id_parse_rejected');
} catch (e) {
  fail('APPEND_OVERRIDE section threw: ' + (e && e.message ? e.message : e));
}

// ---------- SET_DEFAULT ----------

try {
  const key = "abc123^51.9,-2.1^51.5,-2.0^DRIVE";
  const r1 = runHandler({}, "SET_DEFAULT", { targetKey: key, isSet: true });
  const p1 = JSON.parse(r1.result);
  assert.equal(p1.ok, true, 'SET_DEFAULT set must succeed');
  assert.equal(p1.action, "set", 'SET_DEFAULT must report set');
  const prefs1 = prefsOf(r1.store);
  assert.equal(prefs1.seriesPreferences["abc123"]["51.9,-2.1^51.5,-2.0"].defaults["DRIVE"], true, 'default must land in seriesPreferences');
  assert(prefs1["Route_Defaults"].indexOf(key) !== -1, 'Route_Defaults projection must carry the key');
  assert.equal(r1.sandbox.local('cancel_id'), "abc123", 'cancel_id must carry the core ID');

  // Wipe the exact category (DRIVE) but keep other categories' defaults.
  const keyLatency = "abc123^51.9,-2.1^51.5,-2.0^IGNORELATENESS";
  const r2 = runHandler({}, "SET_DEFAULT", { targetKey: key, isSet: true });
  const r3 = runHandler(r2.store.files, "SET_DEFAULT", { targetKey: keyLatency, isSet: true });
  const r4 = runHandler(r3.store.files, "SET_DEFAULT", { targetKey: key, isSet: false });
  const prefs4 = prefsOf(r4.store);
  const sp4 = prefs4.seriesPreferences["abc123"]["51.9,-2.1^51.5,-2.0"];
  assert.equal(sp4.defaults["DRIVE"], undefined, 'wipe must remove the DRIVE default');
  assert.equal(sp4.defaults["IGNORELATENESS"], true, 'wipe must keep the LATENESS default (different category)');
  assert(prefs4["Route_Defaults"].indexOf("DRIVE") === -1, 'projection must drop the wiped default');
  assert(prefs4["Route_Defaults"].indexOf("IGNORELATENESS") !== -1, 'projection must keep the surviving default');

  // clearAll empties the whole store.
  const r5 = runHandler(r4.store.files, "SET_DEFAULT", { clearAll: true });
  const p5 = JSON.parse(r5.result);
  assert.equal(p5.ok, true, 'clearAll must succeed');
  assert.equal(p5.action, "cleared_all", 'clearAll must report cleared_all');
  const prefs5 = prefsOf(r5.store);
  assert.deepEqual(prefs5.seriesPreferences, {}, 'clearAll must empty seriesPreferences');
  assert.equal(prefs5["Route_Defaults"] || "", "", 'clearAll must empty Route_Defaults projection');

  // Malformed targetKey rejected.
  const rBad = runHandler({}, "SET_DEFAULT", { targetKey: "abc123^DRIVE", isSet: true });
  const pBad = JSON.parse(rBad.result);
  assert.equal(pBad.ok, false, 'malformed targetKey must be rejected');
  assert.equal(pBad.reason, "malformed_targetKey", 'malformed targetKey must name malformed_targetKey');
} catch (e) {
  fail('SET_DEFAULT section threw: ' + (e && e.message ? e.message : e));
}

// ---------- PRUNE: retention boundaries ----------

try {
  // Legacy OVR whose projections carry recent + stale + far-future IDs.
  const files = {
    [OVR_FILE]: JSON.stringify({
      schemaVersion: 1,
      Forced_Drives: [ID_RECENT, ID_STALE].join(","),
      Skipped_Events: ID_FUTURE_FAR,
      Trimmed_Events: ID_FUTURE_OK
    })
  };
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  const ovr = ovrOf(r.store);
  assert.equal(ovr["Forced_Drives"], ID_RECENT, 'recent ID survives, stale ID pruned');
  assert.equal(ovr["Skipped_Events"] || "", "", 'far-future ID must be excluded');
  assert.equal(ovr["Trimmed_Events"], ID_FUTURE_OK, 'near-future ID inside 12h exclusion survives');

  // Whitelist overrides retention: a stale ID explicitly whitelisted survives.
  const filesW = { [OVR_FILE]: JSON.stringify({ schemaVersion: 1, Forced_Drives: ID_WHITELIST }) };
  const rW = runHandler(filesW, "PRUNE", { nowSec: nowSec, whitelistMap: { [ID_WHITELIST]: true } });
  const ovrW = ovrOf(rW.store);
  assert.equal(ovrW["Forced_Drives"], ID_WHITELIST, 'whitelisted stale ID must survive');
} catch (e) {
  fail('PRUNE retention section threw: ' + (e && e.message ? e.message : e));
}

// ---------- PRUNE: global memory CSV pruning ----------

try {
  const globals = {
    "TDS_Depart_Memory": ID_DEPART_OK + "~depart," + ID_DEPART_FAR + "~depart",
    "TDS_Completed_Dropins": ID_RECENT + "~done," + ID_STALE + "~done",
    "TDS_Arrival_Memory": ID_FUTURE_OK + "~arrive"
  };
  const r = runHandler({}, "PRUNE", { nowSec: nowSec, whitelistMap: {} }, {}, globals);
  const g = r.store.globals;
  assert.equal(g["TDS_Depart_Memory"], ID_DEPART_OK + "~depart", 'Depart window keeps 2h-ahead, prunes 5h-ahead');
  assert.equal(g["TDS_Completed_Dropins"], ID_RECENT + "~done", '24h retention keeps recent, prunes stale dropin');
  assert.equal(g["TDS_Arrival_Memory"], ID_FUTURE_OK + "~arrive", 'future within 12h exclusion survives arrival');
} catch (e) {
  fail('PRUNE globals section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Propose-default: third categorized occurrence ----------

try {
  let files = {};
  let store = null;
  let proposed = null;
  for (let i = 0; i < 3; i++) {
    const r = runHandler(files, "APPEND_OVERRIDE", {
      baseId: ID_RECENT,
      targetArray: "Forced_Drives",
      routeSig: "51.9,-2.1^51.5,-2.0",
      modeForHistory: "DRIVE"
    });
    files = r.store.files;
    store = r.store;
    const got = r.sandbox.local('propose_default');
    if (got) proposed = got;
  }
  assert(proposed !== null, 'third categorized occurrence must propose a default');
  assert.equal(proposed, "abc123^51.9,-2.1^51.5,-2.0^DRIVE", 'proposed default must be core^route^modifier');
  const prefs = prefsOf(store);
  assert.equal(prefs.seriesPreferences["abc123"]["51.9,-2.1^51.5,-2.0"].history["DRIVE"], 3, 'history must reach 3');
} catch (e) {
  fail('propose-default section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Projection sync: map and CSV projections agree ----------

try {
  const r1 = runHandler({}, "APPLY_OVERRIDE", { targetId: ID_RECENT, overrideKey: "Forced_Lifts" });
  const r2 = runHandler(r1.store.files, "APPEND_OVERRIDE", { baseId: ID_DECOY, targetArray: "Skipped_Events" });
  const ovr = ovrOf(r2.store);

  // Map is authoritative: every non-empty projection must be backed by an
  // entry with the matching category set, and vice versa.
  const projectionOf = function (arr) {
    return (ovr[arr] || "").split(",").filter(function (s) { return s !== ""; });
  };
  const mapKeys = Object.keys(ovr.eventOverrides);
  const projKeys = [];
  ["Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives",
    "Forced_Lift_Chains", "Forced_Drive_Chains", "Skipped_Pitstops",
    "Forced_Pitstops", "Skipped_Events", "Trimmed_Events",
    "Ignored_Lateness", "Ignored_Walks"].forEach(function (arr) {
    projectionOf(arr).forEach(function (k) {
      if (projKeys.indexOf(k) === -1) projKeys.push(k);
    });
  });
  assert.equal(mapKeys.length, 2, 'map must hold exactly the two occurrences');
  assert.equal(projKeys.length, 2, 'projections must list exactly the two occurrences');
  assert.equal(mapKeys.indexOf(ID_RECENT) !== -1 && projKeys.indexOf(ID_RECENT) !== -1, true, 'ID_RECENT present in map and projections');
  assert.equal(mapKeys.indexOf(ID_DECOY) !== -1 && projKeys.indexOf(ID_DECOY) !== -1, true, 'ID_DECOY present in map and projections');
} catch (e) {
  fail('projection sync section threw: ' + (e && e.message ? e.message : e));
}

if (failures > 0) {
  console.log('FAIL: Override Single Writer — ' + failures + ' assertion group(s) failed');
  process.exit(1);
}
console.log('PASS: Override Single Writer — shell dispatch, exact-key helpers, migration + rollback, APPLY/APPEND/SET_DEFAULT/PRUNE ops, retention, globals, propose-default, projection sync');
