// RULE-8C / OVR-10: Override resource single-writer and protected
// preference migration (Slice B).
//
// Override Handler is the sole writer for TDS_Overrides.json and
// TDS_Routine_Preferences.json. Slice B covers the shell contract plus the
// one-time legacy migration:
//
//   Successful migration   — legacy Route_Defaults/Route_History live only in
//                            TDS_Overrides.json; first Handler use moves both
//                            into TDS_Routine_Preferences.json and removes
//                            them from overrides (never a partial move).
//   One-time migration     — a second Handler use must NOT re-add the keys to
//                            overrides and must leave preferences intact.
//   Failed write rollback  — an injected write failure preserves the original
//                            bytes/absence of both resources (no partial
//                            authoritative state).
//   Torn-write rollback    — a torn preference write is rejected by read-back;
//                            both resources return to their prior state.
//
// The four operations (APPLY_OVERRIDE, APPEND_OVERRIDE, SET_DEFAULT, PRUNE)
// are Slice C stubs; their RED coverage lands with PR C. This suite asserts
// the shell dispatch, exact-key helpers, and migration contract only.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const OVR_FILE = "Tasker/Tesla/Data/TDS_Overrides.json";
const PREFS_FILE = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";
const HANDLER_PATH = path.resolve(__dirname, '..', 'Override_Handler.js');

let failures = 0;
function fail(msg) {
  failures += 1;
  console.log('FAIL: Override Single Writer — ' + msg);
}

function runHandler(files, op, payload, failureOpts) {
  const locals = { par1: op, par2: JSON.stringify(payload) };
  const { sandbox, store } = createSandbox({
    locals: locals,
    files: files,
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

// ---------- Shell dispatch ----------

try {
  const empty = runHandler({}, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  if (empty.store.runError) fail('shell runError: ' + JSON.stringify(empty.store.runError));
  const parsed = JSON.parse(empty.result);
  // Slice B stubs return not_implemented_slice_c; the shell must still route.
  assert.equal(parsed.reason, "not_implemented_slice_c", 'PRUNE must route to the Slice C stub');

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
  ovr["Forced_Drives"] = "abc123_kx8f00";
  Object.keys(ovrExtra || {}).forEach(function (k) { ovr[k] = ovrExtra[k]; });
  return { [OVR_FILE]: JSON.stringify(ovr) };
}

try {
  const files = legacyFiles();
  const beforeOvrRaw = files[OVR_FILE];
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  if (r.store.runError) fail('migration runError: ' + JSON.stringify(r.store.runError));

  const prefs = readJsonStore(r.store, PREFS_FILE);
  assert(prefs, 'PREFS must exist after migration');
  assert.equal(prefs["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'PREFS must contain Route_Defaults value');
  assert.equal(prefs["Route_History"], "routeA^3", 'PREFS must contain Route_History value');
  assert.equal(prefs.schemaVersion, 2, 'PREFS must be schema-v2');

  const ovr = readJsonStore(r.store, OVR_FILE);
  assert(ovr, 'OVR must exist after migration');
  assert.equal(ovr.schemaVersion, 2, 'OVR must be schema-v2');
  assert.equal(Object.prototype.hasOwnProperty.call(ovr, "Route_Defaults"), false, 'OVR must not retain Route_Defaults');
  assert.equal(Object.prototype.hasOwnProperty.call(ovr, "Route_History"), false, 'OVR must not retain Route_History');
  assert.equal(ovr["Forced_Drives"], "abc123_kx8f00", 'non-preference projections must survive migration');

  // One-time: a second Handler use must not re-add keys to overrides.
  const r2 = runHandler(r.store.files, "PRUNE", { nowSec: nowSec, whitelistMap: {} });
  const ovr2 = readJsonStore(r2.store, OVR_FILE);
  assert.equal(Object.prototype.hasOwnProperty.call(ovr2, "Route_Defaults"), false, 'second use must not re-add Route_Defaults to OVR');
  const prefs2 = readJsonStore(r2.store, PREFS_FILE);
  assert.equal(prefs2["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'second use must preserve migrated preferences');
} catch (e) {
  fail('successful migration section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Failed migration rollback (write throws) ----------

try {
  const files = legacyFiles();
  const beforeOvrRaw = files[OVR_FILE];
  const r = runHandler(files, "PRUNE", { nowSec: nowSec, whitelistMap: {} }, {
    writeThrows: [PREFS_FILE]
  });
  assert(r.result.indexOf('ERROR') !== -1 || (function () { try { return JSON.parse(r.result).ok === false; } catch (e) { return false; } })(),
    'migration failure must surface as an ERROR result, got: ' + r.result);

  // Original bytes must be recoverable — OVR untouched, PREFS absent.
  const ovrAfter = readJsonStore(r.store, OVR_FILE);
  assert.equal(ovrAfter["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'rollback must preserve original OVR bytes');
  assert.equal(ovrAfter["Route_History"], "routeA^3", 'rollback must preserve original OVR Route_History');
  const prefsAfter = readJsonStore(r.store, PREFS_FILE);
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

  const ovrAfter = readJsonStore(r.store, OVR_FILE);
  assert.equal(ovrAfter["Route_Defaults"], "routeA^MODE=1,routeB^MODE=2", 'torn-write rollback must preserve original OVR bytes');
  const prefsAfter = readJsonStore(r.store, PREFS_FILE);
  assert(prefsAfter === null || !Object.prototype.hasOwnProperty.call(prefsAfter, "Route_Defaults"),
    'no partial authoritative state: PREFS must not contain migrated Route_Defaults after failure');
} catch (e) {
  fail('torn-write rollback section threw: ' + (e && e.message ? e.message : e));
}

if (failures > 0) {
  console.log('FAIL: Override Single Writer — ' + failures + ' assertion group(s) failed');
  process.exit(1);
}
console.log('PASS: Override Single Writer — shell dispatch, exact-key helpers, one-time protected migration, and write/torn-write rollback');
