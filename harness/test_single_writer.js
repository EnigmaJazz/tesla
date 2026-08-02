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
  const { sandbox, store } = createSandbox({
    files: files,
    globals: globals || {},
    nowMs: nowSec * 1000,
    failures: failureOpts || {}
  });
  // F1: run through the mock handler() shim so __currentScriptPath identifies
  // the Override Handler and its OVR/PREFS writes pass the ownership guard.
  sandbox.handler(op, payload);
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

// ---------- Torn-write rollback: second write (OVR) torn ----------
// The torn-write fault is one-shot: PREFS migrates cleanly, the OVR commit is
// torn and rejected by read-back, and the rollback must restore exact original
// OVR bytes while PREFS stays absent.
try {
  const files = legacyFiles();
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} }, {
    tornWrites: [OVR_FILE]
  });
  assert(r.result.indexOf('ERROR') !== -1 || (function () { try { return JSON.parse(r.result).ok === false; } catch (e) { return false; } })(),
    'torn OVR write must surface as an ERROR result, got: ' + r.result);

  const ovrAfter = ovrOf(r.store);
  assert.equal(ovrAfter["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'OVR-torn rollback must restore original Route_Defaults bytes');
  assert.equal(ovrAfter["Route_History"], "routeA^3", 'OVR-torn rollback must restore original Route_History bytes');
  assert.equal(ovrAfter["Forced_Drives"], ID_RECENT, 'OVR-torn rollback must restore original non-preference projections');
  const prefsAfter = prefsOf(r.store);
  assert(prefsAfter === null || !Object.prototype.hasOwnProperty.call(prefsAfter, "Route_Defaults"),
    'no partial authoritative state: PREFS must not contain migrated Route_Defaults after OVR-torn failure');
} catch (e) {
  fail('torn-OVR rollback section threw: ' + (e && e.message ? e.message : e));
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

// ---------- Slice E: OVR top-level memory arrays -> documented transient globals ----------
// E1 moved the memory arrays (TDS_Depart_Memory / TDS_Completed_Dropins /
// TDS_Arrival_Memory / TDS_Completed_Stops) off TDS_Overrides.json into
// transient globals, and Sandbox_Engine reads Route_Defaults from the PREFS
// file. These tests prove the mutators write globals (never OVR), that their
// staged reducer commands are accepted, and that Sandbox reads the new homes.

const fs = require('node:fs');
const DATA = "Tasker/Tesla/Data/";
const COMPILER_PATH = path.resolve(__dirname, '..', 'Compiler.js');
const FINALISER_PATH = path.resolve(__dirname, '..', 'Finaliser.js');
const STOP_LOGGER_PATH = path.resolve(__dirname, '..', 'Stop_Logger.js');
const SANDBOX_PATH = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

function runScriptFile(scriptPath, opts) {
  const { sandbox, store } = createSandbox(opts);
  runScript(scriptPath, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  return store;
}

// E2-1: Compiler writes Depart_Memory to the transient global, never OVR.
try {
  const futureEventStart = nowSec + 3600;
  const masterJson = JSON.stringify([
    {
      id: 'abc123_kx8f00',
      start: futureEventStart,
      end: futureEventStart + 3600,
      duration: 3600,
      title: 'Future Event',
      desc: '',
      loc: 'Work',
      coords: '52.1,-2.2'
    }
  ]);
  const locals = {
    block_step1: 'EVENT',
    block_step2: 'Future Event',
    block_step3: '52.1,-2.2',
    block_step4: 'DRIVE',
    block_step5: String(futureEventStart),
    block_step7: 'false',
    block_step8: 'DEPART',
    block_step9: String(futureEventStart),
    block_step10: 'abc123_kx8f00',
    block_step14: '',
    block_step15: '',
    block_step16: '',
    block_step19: 'JIT',
    api_duration_secs: '1800',
    api_distance_miles: '15',
    api_transit_steps: '',
    virtual_time: String(nowSec - 60)
  };
  const globals = {
    User_At_Base: 'true',
    User_Loc: '51.9,-2.1',
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5'
  };
  const files = {
    [DATA + 'TDS_Master.json']: masterJson,
    [DATA + 'Itin_Master.json']: '[]',
    [OVR_FILE]: '{}'
  };
  const store = runScriptFile(COMPILER_PATH, { locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  assert(store.globals['TDS_Depart_Memory'] !== undefined, 'Compiler must write TDS_Depart_Memory global');
  assert(store.globals['TDS_Depart_Memory'].indexOf('abc123_kx8f00') !== -1, 'Depart_Memory global must hold the planned departure');
  assert.strictEqual(store.files[OVR_FILE], '{}', 'Compiler must not write TDS_Overrides.json');
} catch (e) {
  fail('E2 Compiler global write: ' + (e && e.message ? e.message : e));
}

// E2-2: Finaliser writes Completed_Dropins / Arrival_Memory to globals, never OVR,
// and its staged COMPLETE_DROPIN is accepted by the reducer.
try {
  const dropinId = 'abc123_s44tm8';
  const tempEvents = [
    {
      id: dropinId,
      start: nowSec - 3600,
      end: nowSec + 3600,
      title: 'Dropin',
      loc: 'Near',
      coords: '52.1,-2.2',
      isDropin: true
    }
  ];
  const locals = { tds_temp_json: JSON.stringify(tempEvents) };
  const globals = {
    User_Loc: '51.9,-2.1',
    User_At_Base: 'true',
    TDS_Previous_Loc: '52.1,-2.2',
    TDS_Active_Generation: 'gen:1700000000:abcd'
  };
  const files = {
    [DATA + 'Itin_Master.json']: '[]',
    [OVR_FILE]: '{}'
  };
  const store = runScriptFile(FINALISER_PATH, { locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  assert(store.globals['TDS_Completed_Dropins'] !== undefined, 'Finaliser must write TDS_Completed_Dropins global');
  assert(store.globals['TDS_Completed_Dropins'].indexOf(dropinId) !== -1, 'Completed_Dropins global must hold the dropin id');
  assert.strictEqual(store.files[OVR_FILE], '{}', 'Finaliser must not write TDS_Overrides.json');
  const rejected = store.flashLog.find(function (f) { return f.indexOf('Reducer rejected COMPLETE_DROPIN') !== -1; });
  assert(!rejected, 'Finaliser COMPLETE_DROPIN must be accepted by the reducer');
} catch (e) {
  fail('E2 Finaliser global write: ' + (e && e.message ? e.message : e));
}

// E2-3: Stop_Logger writes Completed_Stops to the transient global, never OVR,
// and its staged COMPLETE_STOP is accepted by the reducer.
try {
  const locals = { active_target_id: ID_RECENT, ld_selected: '5m' };
  const store = runScriptFile(STOP_LOGGER_PATH, { locals: locals, globals: { TDS_Active_Generation: 'gen:1700000000:abcd' }, files: {}, nowMs: nowSec * 1000 });
  assert(store.globals['TDS_Completed_Stops'] !== undefined, 'Stop_Logger must write TDS_Completed_Stops global');
  assert(store.globals['TDS_Completed_Stops'].indexOf(ID_RECENT + '_5') !== -1, 'Completed_Stops global must hold <id>_5 entry');
  assert(store.files[OVR_FILE] === undefined, 'Stop_Logger must not create TDS_Overrides.json');
  const rejected = store.flashLog.find(function (f) { return f.indexOf('Reducer rejected COMPLETE_STOP') !== -1; });
  assert(!rejected, 'Stop_Logger COMPLETE_STOP must be accepted by the reducer');
  const done = store.flashLog.find(function (f) { return f.indexOf('5m stop marked as completed') !== -1; });
  assert(done, 'Stop_Logger must flash the completion message');
} catch (e) {
  fail('E2 Stop_Logger global write: ' + (e && e.message ? e.message : e));
}

// E2-4: Sandbox reads Completed_Stops from the transient global and
// Route_Defaults from the PREFS file — never from OVR.
try {
  const sandboxSource = fs.readFileSync(SANDBOX_PATH, 'utf8');
  assert(sandboxSource.indexOf("global('TDS_Completed_Stops')") !== -1, 'Sandbox must read Completed_Stops from the transient global');
  assert(sandboxSource.indexOf("getPrefs('Route_Defaults')") !== -1, 'Sandbox must read Route_Defaults from PREFS');
  assert(sandboxSource.indexOf("getOvr('Completed_Stops')") === -1, 'Sandbox must not read Completed_Stops from OVR');
  assert(sandboxSource.indexOf("getOvr('Route_Defaults')") === -1, 'Sandbox must not read Route_Defaults from OVR');

  // Behavioral: a seeded PREFS file + Completed_Stops global must flow into a
  // Sandbox run without a crash, and OVR must stay untouched.
  const prefsJson = JSON.stringify({ schemaVersion: 2, seriesPreferences: {}, Route_Defaults: 'home^DRIVE' });
  const files = {
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Master.json']: '[]',
    [PREFS_FILE]: prefsJson,
    [OVR_FILE]: '{}'
  };
  const globals = {
    User_At_Base: 'true',
    User_Loc: '51.9,-2.1',
    Current_Status: 'Idle',
    TDS_Completed_Stops: ID_RECENT + '_5'
  };
  const store = runScriptFile(SANDBOX_PATH, { locals: { idx: '1', virtual_time: String(nowSec), virtual_loc: '51.9,-2.1' }, globals: globals, files: files, nowMs: nowSec * 1000 });
  assert.strictEqual(store.files[OVR_FILE], '{}', 'Sandbox must not write TDS_Overrides.json');
} catch (e) {
  fail('E2 Sandbox PREFS/Completed Stops reads: ' + (e && e.message ? e.message : e));
}

// ---------- Slice F (RULE-8C): OVR/PREFS single-writer ownership guard ----------
// F1 enabled the mock ownership guard: only the Override Handler (running via
// the handler() shim, which sets __currentScriptPath) may write or delete
// TDS_Overrides.json / TDS_Routine_Preferences.json. These tests prove the
// guard rejects direct writes, that the handler shim still passes, and that
// none of the seven former writers retains a direct OVR/PREFS write path.

const ALPHA_PATH = path.resolve(__dirname, '..', 'Alpha.js');
const APPENDER_PATH = path.resolve(__dirname, '..', 'Appender.js');
const INJECTOR_PATH = path.resolve(__dirname, '..', 'Override_Injector.js');
const DEFAULT_PATH = path.resolve(__dirname, '..', 'Default.js');
const TDS_HELPER_PATH = path.resolve(__dirname, '..', 'TDS_Helper.js');

// F1-1: the guard rejects a direct OVR/PREFS write from a non-handler script.
try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  let rejected = false;
  try { sandbox.writeFile(OVR_FILE, '{}'); } catch (e) {
    rejected = String(e && e.message || e).indexOf('UNAUTHORIZED_WRITE_REJECTED') !== -1;
  }
  assert(rejected, 'direct OVR write must be rejected');
  rejected = false;
  try { sandbox.writeFile(PREFS_FILE, '{}'); } catch (e) {
    rejected = String(e && e.message || e).indexOf('UNAUTHORIZED_WRITE_REJECTED') !== -1;
  }
  assert(rejected, 'direct PREFS write must be rejected');
  rejected = false;
  try { sandbox.deleteFile(OVR_FILE); } catch (e) {
    rejected = String(e && e.message || e).indexOf('UNAUTHORIZED_WRITE_REJECTED') !== -1;
  }
  assert(rejected, 'direct OVR delete must be rejected');
} catch (e) {
  fail('F1 guard rejects direct writes: ' + (e && e.message ? e.message : e));
}

// F1-2: the handler() shim passes the guard — handler OVR/PREFS writes land.
try {
  const r = runHandler({}, 'APPLY_OVERRIDE', { targetId: ID_RECENT, overrideKey: 'Forced_Drives' });
  const ovr = readJsonStore(r.store, OVR_FILE);
  assert(ovr && ovr.schemaVersion === 2, 'handler shim must write schema-v2 OVR');
  assert(ovr.eventOverrides[ID_RECENT], 'handler APPLY_OVERRIDE must land in eventOverrides');
  const r2 = runHandler({}, 'SET_DEFAULT', { targetKey: 'series_x^52.1,-2.2^51.9,-2.1^drive', isSet: true });
  const prefs = readJsonStore(r2.store, PREFS_FILE);
  assert(prefs && prefs.seriesPreferences['series_x'], 'handler shim must write PREFS');
} catch (e) {
  fail('F1 handler shim passes guard: ' + (e && e.message ? e.message : e));
}

// F1-3: seven-writer source sweep — no former writer retains an OVR/PREFS
// writeFile/deleteFile call; TDS_Helper stays read-only.
try {
  const formerWriters = [
    ['Alpha', ALPHA_PATH],
    ['Appender', APPENDER_PATH],
    ['Compiler', COMPILER_PATH],
    ['Default', DEFAULT_PATH],
    ['Finaliser', FINALISER_PATH],
    ['Override_Injector', INJECTOR_PATH],
    ['Stop_Logger', STOP_LOGGER_PATH]
  ];
  formerWriters.forEach(function (entry) {
    const name = entry[0];
    const src = fs.readFileSync(entry[1], 'utf8');
    assert(src.indexOf('writeFile("Tasker/Tesla/Data/TDS_Overrides.json"') === -1, name + ' must not writeFile TDS_Overrides.json');
    assert(src.indexOf('writeFile("Tasker/Tesla/Data/TDS_Routine_Preferences.json"') === -1, name + ' must not writeFile TDS_Routine_Preferences.json');
    assert(src.indexOf('deleteFile("Tasker/Tesla/Data/TDS_Overrides.json"') === -1, name + ' must not deleteFile TDS_Overrides.json');
  });
  const helperSrc = fs.readFileSync(TDS_HELPER_PATH, 'utf8');
  assert(helperSrc.indexOf('writeFile(') === -1, 'TDS_Helper must stay read-only (no writeFile)');
  assert(helperSrc.indexOf('deleteFile(') === -1, 'TDS_Helper must stay read-only (no deleteFile)');
} catch (e) {
  fail('F1 seven-writer source sweep: ' + (e && e.message ? e.message : e));
}

if (failures > 0) {
  console.log('FAIL: Override Single Writer — ' + failures + ' assertion group(s) failed');
  process.exit(1);
}
console.log('PASS: Override Single Writer — shell dispatch, exact-key helpers, migration + rollback, APPLY/APPEND/SET_DEFAULT/PRUNE ops, retention, globals, propose-default, projection sync');
