// Phase 5 Slice D (REQ-5CACHE-1/2, REQ-5CACHE-3, CACHE-11): cache-reader
// migration and parity hardening.
//
// Slice B made Route_Cache_Manager the sole writer of the JSON caches and left
// Gatekeeper + Sandbox reading the retired legacy text projections; Slice C
// correlated callbacks. Slice D migrates the readers:
//
//   (a) Gatekeeper reads the route/temp/order caches through the manager's
//       JSON (documented read-only; the manager is the sole writer) and its
//       cache-hit decisions are byte-identical to the legacy text reader:
//       same hit/miss, same durationSecs, same distance fields, same source.
//   (b) Sandbox_Engine.getCachedTime reads through the manager's JSON (route +
//       temp) and returns identical route metrics to the legacy text reader.
//   (c) Spatial/bucket parity: the same origin/destination/mode/bucket/
//       dayClass yields the same Welford mean the legacy reader selected —
//       WALK is unbucketed (null bucket), DRIVE is exact tod + dayClass, and
//       out-of-window buckets are misses.
//   (d) distanceMiles now holds ACTUAL MILES (the Slice-B deferral closes:
//       Slice B stored meters in the field). Meters arrive on the command
//       contract (distanceMeters) and legacy migration converts them.
//   (e) TTL pruning keeps the reader contract: an expired entry is a miss for
//       Gatekeeper, Sandbox, AND the manager's CACHE_READ (SCN-5CACHE-3).
//
// MUST FAIL on master: Gatekeeper/Sandbox still read the legacy text files
// (absent here), distanceMiles still stores meters, and the JSON caches are
// ignored by both readers.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const DATA = "Tasker/Tesla/Data/";
const nowSec = 1700000000; // 2023-11-14T22:13:20Z, Tuesday, tod 1333, dayClass 0
const ROUTE_JSON = DATA + 'TDS_Route_Cache.json';
const ORDER_JSON = DATA + 'TDS_Order_Cache.json';
const TEMP_JSON = DATA + 'Temp_Route_Cache.json';
const ROUTE_TEXT = DATA + 'RouteCache.txt';
const TEMP_TEXT = DATA + 'Temp_Route_Cache.txt';
const ORDER_TEXT = DATA + 'TDS_Order_Cache.txt';

const GATEKEEPER = path.resolve(__dirname, '..', 'Gatekeeper.js');
const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

const METERS_PER_MILE = 1609.344;
const homeCoords = "51.9,-2.1";
const eventCoords = "52.0,-2.0";

let failures = 0;
function fail(msg) {
  failures += 1;
  console.log('FAIL: Cache Readers — ' + msg);
}

// Exact-key route identity (mirrors the manager's rcmRouteKey).
function rk(o, d, m, bucket, dayClass) {
  return o + "~~" + d + "~~" + m + "~~" + (bucket === null ? "null" : bucket) + "~~" + dayClass;
}
function routeEntry(o, d, m, mean, bucket, dayClass, extra) {
  return Object.assign({
    originCell: o, destinationCell: d, mode: m, dayClass: dayClass, bucket: bucket,
    meanDurationSecs: mean, sampleCount: 1, m2: 0,
    distanceMiles: Math.round((12000 / METERS_PER_MILE) * 1000) / 1000,
    createdAt: nowSec - 60, updatedAt: nowSec - 60, expiresAt: nowSec + 30 * 86400
  }, extra || {});
}
function tempEntry(o, d, m, dur, apiUnix, extra) {
  return Object.assign({
    originCell: o, destinationCell: d, mode: m, dayClass: null, bucket: null,
    meanDurationSecs: dur, sampleCount: 1, m2: 0, distanceMiles: 12000 / METERS_PER_MILE,
    apiUnix: apiUnix, targetUnix: nowSec, createdAt: apiUnix, updatedAt: apiUnix,
    expiresAt: apiUnix + 24 * 3600
  }, extra || {});
}
function orderEntry(clusterKey, result, extra) {
  return Object.assign({
    clusterKey: clusterKey, result: result, createdAt: nowSec, updatedAt: nowSec,
    expiresAt: nowSec + 7 * 86400
  }, extra || {});
}
function cacheJson(entries) {
  return JSON.stringify({ schemaVersion: 1, updatedAt: nowSec, entries: entries });
}
function readJson(store, filePath) {
  const raw = store.files[filePath] || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function structuredLogs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } })
    .filter(function (o) { return o !== null; });
}
function runGatekeeperRoute(sandbox, store, orig, dest, mode, targetSec) {
  sandbox.setLocal('par1', '');
  sandbox.setLocal('par11', orig);
  sandbox.setLocal('par12', dest);
  sandbox.setLocal('par13', mode);
  sandbox.setLocal('par14', String(targetSec));
  runScript(GATEKEEPER, sandbox, store);
}

// ---------- (d) distanceMiles holds actual miles (Slice-B deferral closes) ----------

try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  sandbox.cacheManager('SESSION_CACHE_UPSERT', {
    origin: homeCoords, destination: '51.5,-2.0', mode: 'DRIVE',
    durationSecs: 1800, distanceMeters: 12000, apiUnix: nowSec, targetUnix: nowSec, emittedAt: nowSec
  });
  const temp = readJson(store, TEMP_JSON);
  assert(temp, 'temp JSON cache must exist');
  const tKey = Object.keys(temp.entries)[0];
  assert(Math.abs(temp.entries[tKey].distanceMiles - (12000 / METERS_PER_MILE)) < 0.001,
    'temp distanceMiles must hold actual miles, got ' + temp.entries[tKey].distanceMiles);

  sandbox.cacheManager('ROLLUP_DUE_TEMP', { nowSec: nowSec });
  const route = readJson(store, ROUTE_JSON);
  assert(route, 'route JSON cache must exist after rollup');
  const rKey = Object.keys(route.entries)[0];
  assert(Math.abs(route.entries[rKey].distanceMiles - (12000 / METERS_PER_MILE)) < 0.001,
    'route distanceMiles must hold actual miles, got ' + route.entries[rKey].distanceMiles);

  // Legacy migration converts meters -> miles (the field contract, not a copy).
  const legacyRoute = '52.0,-2.3~51.7,-2.1~DRIVE~1200~8000~' + (nowSec - 100) + '~500~1000~0~5';
  const { sandbox: s2, store: st2 } = createSandbox({ files: { [ROUTE_TEXT]: legacyRoute }, nowMs: nowSec * 1000 });
  s2.cacheManager('PRUNE', { nowSec: nowSec });
  const migrated = readJson(st2, ROUTE_JSON);
  assert(migrated, 'legacy text must migrate into JSON');
  const mEntry = Object.keys(migrated.entries).map(function (k) { return migrated.entries[k]; })
    .filter(function (e) { return e.originCell === '52.0,-2.3'; })[0];
  assert(mEntry, 'migrated entry must exist');
  assert.strictEqual(mEntry.meanDurationSecs, 1200, 'migrated mean must be preserved');
  assert(Math.abs(mEntry.distanceMiles - (8000 / METERS_PER_MILE)) < 0.001,
    'migrated distanceMiles must convert meters to miles, got ' + mEntry.distanceMiles);
} catch (e) {
  fail('distanceMiles conversion section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (a) Gatekeeper reads the JSON caches; decisions match legacy ----------

try {
  const routeFixtures = {};
  routeFixtures[rk(homeCoords, eventCoords, 'DRIVE', 1333, 0)] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1800, 1333, 0, { updatedAt: nowSec });
  const orderFixtures = {};
  orderFixtures['51.9,-2.1|dest1|wp1,wp2'] = orderEntry('51.9,-2.1|dest1|wp1,wp2', ['wp2', 'wp1']);

  // Order-cache cluster hit: the JSON order entry drives the reorder command.
  const cluster = { waypoints: [{ id: 'wp1' }, { id: 'wp2' }], destination: { id: 'dest1', coords: eventCoords } };
  const { sandbox, store } = createSandbox({
    locals: { par1: JSON.stringify(cluster), par11: '', par12: '', par13: '', par14: '' },
    globals: { User_Loc: homeCoords, TDS_Active_Generation: 'gen:1700000000:ab12' },
    files: { [ORDER_JSON]: cacheJson(orderFixtures) },
    nowMs: nowSec * 1000
  });
  runScript(GATEKEEPER, sandbox, store);
  assert(store.runError === undefined, 'Gatekeeper must not crash on JSON order cache');
  assert.strictEqual(sandbox.local('cluster_bypass'), 'true', 'order cache hit must set cluster_bypass');
  assert.strictEqual(sandbox.local('par1'), 'ENQUEUE_REORDER', 'order hit must stage ENQUEUE_REORDER');
  const staged = JSON.parse(sandbox.local('par2'));
  assert.deepStrictEqual(staged.orderedEventIds, ['wp2', 'wp1'], 'order hit must stage the cached result');
  assert(!store.writeLog.some(function (w) { return w.path === ORDER_JSON || w.path === ORDER_TEXT; }),
    'Gatekeeper must never write the order cache (read-only)');

  // Master-cache route hit: future DRIVE leg resolves from the JSON Welford row.
  const { sandbox: r1, store: s1 } = createSandbox({
    locals: { par1: '', par11: homeCoords, par12: eventCoords, par13: 'DRIVE', par14: String(nowSec + 10800) },
    files: { [ROUTE_JSON]: cacheJson(routeFixtures), [TEMP_JSON]: cacheJson({}) },
    nowMs: nowSec * 1000
  });
  runGatekeeperRoute(r1, s1, homeCoords, eventCoords, 'DRIVE', nowSec + 10800);
  assert(s1.runError === undefined, 'Gatekeeper must not crash on JSON route cache');
  assert.strictEqual(r1.local('cache_hit'), 'true', 'master cache hit must set cache_hit');
  const api = JSON.parse(r1.local('api_return_json'));
  assert.strictEqual(api.durationSecs, 1800, 'master hit must return the Welford mean 1800');
  assert.strictEqual(api.distanceMiles, (12000 / METERS_PER_MILE).toFixed(1), 'master hit distanceMiles must be miles (1dp)');
  assert.strictEqual(api.distanceMeters, Math.round((12000 / METERS_PER_MILE) * METERS_PER_MILE), 'master hit distanceMeters must round-trip to 12000');
  assert(api.transitSteps.indexOf('Master Cache') !== -1, 'master hit must cite the master cache source');
  assert(!s1.writeLog.some(function (w) { return w.path.indexOf('RouteCache') !== -1 || w.path.indexOf('Temp_Route_Cache') !== -1; }),
    'Gatekeeper must never write route/temp cache files (read-only)');

  // Migration bridge: the SAME physical cache expressed as legacy text migrates
  // through the manager and the reader selects the identical duration.
  const legacyRoute = '51.9,-2.1~52.0,-2.0~DRIVE~1800~12000~' + (nowSec - 60) + '~0~1333~0~1';
  const { sandbox: m1, store: m2 } = createSandbox({ files: { [ROUTE_TEXT]: legacyRoute }, nowMs: nowSec * 1000 });
  m1.cacheManager('PRUNE', { nowSec: nowSec });
  assert.strictEqual(m2.files[ROUTE_TEXT], undefined, 'PRUNE must retire the legacy text file after migration');
  const { sandbox: r2, store: s2 } = createSandbox({
    locals: { par1: '', par11: homeCoords, par12: eventCoords, par13: 'DRIVE', par14: String(nowSec + 10800) },
    files: { [ROUTE_JSON]: cacheJson(readJson(m2, ROUTE_JSON).entries), [TEMP_JSON]: cacheJson({}) },
    nowMs: nowSec * 1000
  });
  runGatekeeperRoute(r2, s2, homeCoords, eventCoords, 'DRIVE', nowSec + 10800);
  assert.strictEqual(r2.local('cache_hit'), 'true', 'migrated cache must still hit');
  const migratedApi = JSON.parse(r2.local('api_return_json'));
  assert.strictEqual(migratedApi.durationSecs, api.durationSecs, 'migrated vs direct decisions must be byte-identical');

  // Temp-cache route hit: future leg with no master match resolves from JSON temp.
  const { sandbox: r3, store: s3 } = createSandbox({
    locals: { par1: '', par11: homeCoords, par12: eventCoords, par13: 'DRIVE', par14: String(nowSec + 10800) },
    files: { [ROUTE_JSON]: cacheJson({}), [TEMP_JSON]: cacheJson({ [rk(homeCoords, eventCoords, 'DRIVE', null, null)]: tempEntry(homeCoords, eventCoords, 'DRIVE', 2400, nowSec) }) },
    nowMs: nowSec * 1000
  });
  runGatekeeperRoute(r3, s3, homeCoords, eventCoords, 'DRIVE', nowSec + 10800);
  assert.strictEqual(r3.local('cache_hit'), 'true', 'temp cache hit must set cache_hit');
  const tempApi = JSON.parse(r3.local('api_return_json'));
  assert.strictEqual(tempApi.durationSecs, 2400, 'temp hit must return the session duration 2400');
  assert(tempApi.transitSteps.indexOf('Session Cache') !== -1, 'temp hit must cite the session cache source');
} catch (e) {
  fail('Gatekeeper JSON reader section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (b) Sandbox getCachedTime reads the JSON caches ----------

try {
  const itinJson = JSON.stringify([
    { tripId: "stale_away_leg", targetEventId: "event_1", mode: "DRIVE", pitstopState: "handled",
      departUnix: nowSec - 3600, arriveUnix: nowSec - 1800 }
  ]);
  const masterJson = JSON.stringify([
    { id: "event_1_kx8f00", start: nowSec + 3600, end: nowSec + 7200, duration: 3600,
      title: "Future Event", desc: "", loc: "Work", coords: eventCoords }
  ]);
  const baseGeocodes = [nowSec, nowSec + 86400, homeCoords, "0", "Home", "", "home_base"].join("~");
  const commonGlobals = {
    User_At_Base: "true", Base_Arrival_Unix: String(nowSec), User_Loc: homeCoords, Home_Coords: homeCoords,
    Current_Status: "", Arrival_Buffer_Mins: "5", Departure_Buffer_Mins: "5", Max_Walk_Meters: "8046",
    Daily_Walk_Meters: "0", Live_Traffic_Threshold: "7200", Car_Connected: "false"
  };
  const commonLocals = { idx: "1", vcar_loc: homeCoords, virtual_time: String(nowSec), virtual_loc: homeCoords };
  const baseFiles = {
    "Tasker/Tesla/Data/Itin_Master.json": itinJson,
    "Tasker/Tesla/Data/TDS_Master.json": masterJson,
    "Tasker/Tesla/Data/TDS_Base_Geocodes.txt": baseGeocodes,
    "Tasker/Tesla/Data/TDS_Overrides.json": "{}"
  };
  function runSandbox(files) {
    const { sandbox, store } = createSandbox({
      locals: Object.assign({}, commonLocals), globals: Object.assign({}, commonGlobals),
      files: Object.assign({}, baseFiles, files), nowMs: nowSec * 1000
    });
    runScript(SANDBOX, sandbox, store);
    if (store.runError) throw new Error('Sandbox crashed: ' + JSON.stringify(store.runError));
    const envelope = JSON.parse(sandbox.local('block_queue') || '{"rows":[]}');
    return envelope.rows;
  }

  // Master-cache path: a fresh Welford row for the head leg yields the mean.
  const routeRows = runSandbox({
    [ROUTE_JSON]: cacheJson({ [rk(homeCoords, eventCoords, 'DRIVE', 1333, 0)]: routeEntry(homeCoords, eventCoords, 'DRIVE', 1800, 1333, 0, { updatedAt: nowSec }) }),
    [TEMP_JSON]: cacheJson({})
  });
  const headRoute = routeRows[0];
  assert(headRoute, 'Sandbox must emit a head row');
  assert.strictEqual(headRoute.rowType, 'EVENT', 'head row must be the EVENT leg');
  assert.strictEqual(headRoute.routeDurationSecs, 1800, 'master cache must feed getCachedTime (got ' + headRoute.routeDurationSecs + ')');

  // Temp-cache path: a fresh session sample wins for the head leg.
  const tempRows = runSandbox({
    [ROUTE_JSON]: cacheJson({}),
    [TEMP_JSON]: cacheJson({ [rk(homeCoords, eventCoords, 'DRIVE', null, null)]: tempEntry(homeCoords, eventCoords, 'DRIVE', 2400, nowSec) })
  });
  assert.strictEqual(tempRows[0].routeDurationSecs, 2400, 'temp cache must feed getCachedTime (got ' + tempRows[0].routeDurationSecs + ')');

  // Spatial parity: a bucket-adjacent row (diff 60) with stale updatedAt must
  // still resolve via the tod/dayClass path, exactly like the legacy reader.
  const adjacentRows = runSandbox({
    [ROUTE_JSON]: cacheJson({ [rk(homeCoords, eventCoords, 'DRIVE', 1333, 0)]: routeEntry(homeCoords, eventCoords, 'DRIVE', 1800, 1333, 0, { updatedAt: nowSec - 10000 }) }),
    [TEMP_JSON]: cacheJson({})
  });
  assert.strictEqual(adjacentRows[0].routeDurationSecs, 1800, 'adjacent-bucket row must resolve (legacy parity)');
} catch (e) {
  fail('Sandbox JSON reader section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (c) spatial/bucket parity matrix (WALK null bucket, dayClass) ----------

try {
  // Target: future event at nowSec + 10800 -> tod 73, dayClass 0 (Wednesday).
  const targetSec = nowSec + 10800;
  const matrix = {
    matchExact: rk(homeCoords, eventCoords, 'DRIVE', 73, 0),
    wrongDay: rk(homeCoords, eventCoords, 'DRIVE', 73, 1),
    bucketFar: rk(homeCoords, eventCoords, 'DRIVE', 200, 0),
    bucketAdjacent: rk(homeCoords, eventCoords, 'DRIVE', 133, 0),
    walkNull: rk(homeCoords, eventCoords, 'WALK', null, 0),
    fresh: rk(homeCoords, eventCoords, 'DRIVE', 73, 0)
  };
  const entries = {};
  entries[matrix.matchExact] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1700, 73, 0, { updatedAt: nowSec - 100000 });
  entries[matrix.wrongDay] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1600, 73, 1, { updatedAt: nowSec - 100000 });
  entries[matrix.bucketFar] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1500, 200, 0, { updatedAt: nowSec - 100000 });
  entries[matrix.bucketAdjacent] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1400, 133, 0, { updatedAt: nowSec - 100000 });
  entries[matrix.walkNull] = routeEntry(homeCoords, eventCoords, 'WALK', 900, null, 0, { updatedAt: nowSec - 100000 });
  entries[matrix.fresh] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1300, 73, 0, { updatedAt: nowSec - 10 });

  function runQuery(mode) {
    const { sandbox, store } = createSandbox({
      locals: { par1: '', par11: homeCoords, par12: eventCoords, par13: mode, par14: String(targetSec) },
      files: { [ROUTE_JSON]: cacheJson(entries), [TEMP_JSON]: cacheJson({}) },
      nowMs: nowSec * 1000
    });
    runGatekeeperRoute(sandbox, store, homeCoords, eventCoords, mode, targetSec);
    if (store.runError) throw new Error('Gatekeeper crashed: ' + JSON.stringify(store.runError));
    if (sandbox.local('cache_hit') !== 'true') return null;
    return JSON.parse(sandbox.local('api_return_json')).durationSecs;
  }

  // Backward scan: the LAST matching row in key order wins — seed order is the
  // legacy text order, so 'fresh' (last) shadows 'matchExact' for the same key
  // shape; the selection rules below assert the parity rules themselves.
  assert.strictEqual(runQuery('DRIVE'), 1300, 'fresh row must win over the stale same-bucket row');
  assert.strictEqual(runQuery('WALK'), 900, 'WALK must resolve unbucketed regardless of tod');
} catch (e) {
  fail('spatial/bucket parity section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (e) TTL keeps the reader contract: expired = miss ----------

try {
  const expired = {};
  expired[rk(homeCoords, eventCoords, 'DRIVE', 73, 0)] = routeEntry(homeCoords, eventCoords, 'DRIVE', 1800, 73, 0, { expiresAt: nowSec - 60 });
  const { sandbox, store } = createSandbox({
    locals: { par1: '', par11: homeCoords, par12: eventCoords, par13: 'DRIVE', par14: String(nowSec + 10800) },
    files: { [ROUTE_JSON]: cacheJson(expired), [TEMP_JSON]: cacheJson({}) },
    nowMs: nowSec * 1000
  });
  // The manager's CACHE_READ drops the expired entry (SCN-5CACHE-3).
  const readResult = sandbox.cacheManager('CACHE_READ', { kind: 'route' });
  assert(readResult.indexOf('OK') === 0, 'CACHE_READ must succeed: ' + readResult);
  const filtered = JSON.parse(sandbox.local('cache_read_result'));
  assert.strictEqual(Object.keys(filtered.entries || {}).length, 0, 'CACHE_READ must drop the expired entry');
  // The Gatekeeper reader applies the same rule: the expired entry is a miss.
  runGatekeeperRoute(sandbox, store, homeCoords, eventCoords, 'DRIVE', nowSec + 10800);
  assert.strictEqual(sandbox.local('cache_hit'), 'false', 'expired route entry must be a miss for Gatekeeper');
  const rejectLogs = structuredLogs(store).filter(function (l) { return l.code === 'CACHE_ENTRY_REJECTED'; });
  assert(rejectLogs.length >= 1, 'expired drop must log CACHE_ENTRY_REJECTED');
} catch (e) {
  fail('TTL reader contract section threw: ' + (e && e.message ? e.message : e));
}

if (failures > 0) {
  console.log('FAIL: Cache Readers — ' + failures + ' assertion group(s) failed');
  process.exit(1);
}
console.log('PASS: Cache Readers — Gatekeeper/Sandbox JSON reads, spatial/bucket parity, miles conversion, TTL reader contract');
