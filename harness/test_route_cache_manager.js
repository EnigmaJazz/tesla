// Phase 5 Slice B (REQ-5CACHE-1/2, RULE-8E, SCN-5CACHE-1..3): Route Cache
// Manager sole-writer contract, JSON cache schemas, Alpha Welford parity, and
// the Temp_Route_Cache multi-writer fix.
//
// Covered:
//   Ownership guard   — TDS_Route_Cache.json / TDS_Order_Cache.json /
//                       Temp_Route_Cache.json / TDS_Route_Request_State.json
//                       AND the legacy text projections (RouteCache.txt,
//                       Temp_Route_Cache.txt, TDS_Order_Cache.txt) are writable
//                       ONLY by Route_Cache_Manager. Direct writes are rejected
//                       without file mutation (CACHE_WRITE_REJECTED).
//   JSON schemas      — schemaVersion / updatedAt / exact-key entries; DRIVE
//                       bucket is the exact tod, WALK bucket is null; Welford
//                       fields (meanDurationSecs, sampleCount, m2), distance,
//                       createdAt/updatedAt/expiresAt TTL timestamps.
//   Welford parity    — Alpha's capped-Welford/outlier rollup, run through the
//                       manager, produces the identical RouteCache.txt bytes:
//                       new entry, Welford update, outlier reset, z-score path.
//   Multi-writer fix  — Alpha and API_Parser no longer write the temp/route/
//                       order cache files directly; they stage manager commands
//                       (ROLLUP_DUE_TEMP / SESSION_CACHE_UPSERT /
//                       ORDER_CACHE_UPSERT).
//   EVT codes         — CACHE_WRITE_REJECTED / ROUTE_CACHE_MUTATED /
//                       CACHE_ENTRY_REJECTED in LOG-17 shape.
//
// MUST FAIL on master: no Route_Cache_Manager.js, no cache ownership guards,
// and Alpha/API_Parser still write the cache files directly.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const DATA = "Tasker/Tesla/Data/";
const nowSec = 1700000000; // 2023-11-14T22:13:20Z, Tuesday, tod 1333, dayType 0
const RCM_TEST_FUTURE = 30 * 86400; // future TTL horizon for seeded entries

const ROUTE_JSON = DATA + 'TDS_Route_Cache.json';
const ORDER_JSON = DATA + 'TDS_Order_Cache.json';
const TEMP_JSON = DATA + 'Temp_Route_Cache.json';
const REQUEST_JSON = DATA + 'TDS_Route_Request_State.json';
const ROUTE_TEXT = DATA + 'RouteCache.txt';
const TEMP_TEXT = DATA + 'Temp_Route_Cache.txt';
const ORDER_TEXT = DATA + 'TDS_Order_Cache.txt';

const ALPHA = path.resolve(__dirname, '..', 'Alpha.js');
const API_PARSER = path.resolve(__dirname, '..', 'API_Parser.js');

let failures = 0;
function fail(msg) {
  failures += 1;
  console.log('FAIL: Route Cache Manager — ' + msg);
}

function readJsonStore(store, filePath) {
  const raw = store.files[filePath] || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Run the full production cycle on one sandbox: stage the session sample via
// the manager, run Alpha (which stages ROLLUP_DUE_TEMP), then dispatch the
// manager to commit due samples. Asserts the resulting cache text bytes.
function commitViaAlpha(sample, files, expected) {
  const { sandbox, store } = createSandbox({
    globals: { TIMEMS: String(nowSec * 1000), Auto_Base_Hours: '3' },
    files: Object.assign({}, files),
    nowMs: nowSec * 1000
  });
  const upsert = sandbox.cacheManager('SESSION_CACHE_UPSERT', sample);
  assert(upsert.indexOf('OK') === 0, 'SESSION_CACHE_UPSERT must succeed: ' + upsert);
  runScript(ALPHA, sandbox, store);
  if (store.runError) throw new Error('Alpha crashed: ' + JSON.stringify(store.runError));
  assert.strictEqual(sandbox.local('par1'), 'ROLLUP_DUE_TEMP', 'Alpha must stage ROLLUP_DUE_TEMP');
  const payload = JSON.parse(sandbox.local('par2'));
  assert(payload.prune && typeof payload.prune === 'object', 'Alpha must embed the PRUNE payload for the manager re-stage');
  const result = sandbox.cacheManager('ROLLUP_DUE_TEMP', payload);
  assert(result.indexOf('OK') === 0, 'manager must accept ROLLUP_DUE_TEMP: ' + result);
  assert.strictEqual(sandbox.local('par1'), 'PRUNE', 'manager must re-stage the PRUNE command');
  assert.strictEqual(store.files[ROUTE_TEXT], expected.routeText, 'RouteCache.txt must match the legacy rollup bytes');
  assert.strictEqual(store.files[TEMP_TEXT], expected.tempText, 'Temp_Route_Cache.txt must match the legacy rollup bytes');
  return store;
}
function sample(dur, apiUnix) {
  return {
    origin: '51.9,-2.1', destination: '51.5,-2.0', mode: 'DRIVE',
    durationSecs: dur, distanceMeters: 12000, apiUnix: apiUnix, targetUnix: nowSec, emittedAt: apiUnix
  };
}

// ---------- Ownership guard (SCN-5CACHE-1 / CACHE_WRITE_REJECTED) ----------

try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  const protectedFiles = [ROUTE_JSON, ORDER_JSON, TEMP_JSON, REQUEST_JSON, ROUTE_TEXT, TEMP_TEXT, ORDER_TEXT];
  protectedFiles.forEach(function (f) {
    let rejected = false;
    try { sandbox.writeFile(f, '{}'); } catch (e) {
      rejected = String(e && e.message || e).indexOf('CACHE_WRITE_REJECTED') !== -1;
    }
    assert(rejected, 'direct write of ' + f + ' must be rejected with CACHE_WRITE_REJECTED');
    assert.strictEqual(store.files[f], undefined, 'rejected write must not mutate ' + f);
    // REQ-5LOG-1: the rejection also emits structured LOG-17 evidence.
    const structured = (store.flashLog || []).map(function (msg) {
      try { return JSON.parse(msg); } catch (e) { return null; }
    }).filter(function (o) { return o && o.code === 'CACHE_WRITE_REJECTED' && o.component === 'Route_Cache_Manager'; });
    assert(structured.length > 0, 'CACHE_WRITE_REJECTED must emit structured LOG-17 evidence for ' + f);
    const evt = structured[structured.length - 1];
    assert(typeof evt.timestamp === 'number' && typeof evt.severity === 'string' && evt.details && evt.details.op && evt.details.path,
      'CACHE_WRITE_REJECTED LOG-17 must carry timestamp/severity/details(op,path)');
    rejected = false;
    try { sandbox.deleteFile(f); } catch (e) {
      rejected = String(e && e.message || e).indexOf('CACHE_WRITE_REJECTED') !== -1;
    }
    assert(rejected, 'direct delete of ' + f + ' must be rejected with CACHE_WRITE_REJECTED');
  });
  // The manager shim passes the guard: a SESSION_CACHE_UPSERT lands.
  const r = sandbox.cacheManager('SESSION_CACHE_UPSERT', {
    origin: '51.9,-2.1', destination: '51.5,-2.0', mode: 'DRIVE',
    durationSecs: 1800, distanceMeters: 12000, apiUnix: nowSec, targetUnix: nowSec,
    emittedAt: nowSec
  });
  assert(r.indexOf('OK') === 0, 'manager shim must pass the ownership guard: ' + r);
  assert(readJsonStore(store, TEMP_JSON) !== null, 'manager write must land in Temp_Route_Cache.json');
} catch (e) {
  fail('ownership guard section threw: ' + (e && e.message ? e.message : e));
}

// ---------- JSON schemas (REQ-5CACHE-2 / SCN-5CACHE-2) ----------

try {
  // Session upsert schema.
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  sandbox.cacheManager('SESSION_CACHE_UPSERT', {
    origin: '51.9,-2.1', destination: '51.5,-2.0', mode: 'DRIVE',
    durationSecs: 1800, distanceMeters: 12000, apiUnix: nowSec, targetUnix: nowSec,
    emittedAt: nowSec
  });
  const temp = readJsonStore(store, TEMP_JSON);
  assert(temp, 'Temp_Route_Cache.json must exist');
  assert.strictEqual(temp.schemaVersion, 1, 'temp cache schemaVersion must be 1');
  assert.strictEqual(temp.updatedAt, nowSec, 'temp cache updatedAt must be set');
  const tempKeys = Object.keys(temp.entries);
  assert.strictEqual(tempKeys.length, 1, 'temp cache must hold one sample');
  const sample = temp.entries[tempKeys[0]];
  assert.strictEqual(sample.originCell, '51.9,-2.1', 'sample originCell');
  assert.strictEqual(sample.destinationCell, '51.5,-2.0', 'sample destinationCell');
  assert.strictEqual(sample.mode, 'DRIVE', 'sample mode');
  assert.strictEqual(sample.meanDurationSecs, 1800, 'sample meanDurationSecs');
  assert.strictEqual(sample.sampleCount, 1, 'sample sampleCount');
  assert.strictEqual(sample.m2, 0, 'sample m2');
  assert.strictEqual(sample.distanceMiles, 12000, 'sample distance');
  assert.strictEqual(sample.createdAt, nowSec, 'sample createdAt');
  assert.strictEqual(sample.expiresAt, nowSec + 24 * 3600, 'sample temp TTL must be 24h');
  assert.strictEqual(sample.targetUnix, nowSec, 'sample targetUnix (event time)');
  assert.strictEqual(store.files[TEMP_TEXT], '51.9,-2.1~51.5,-2.0~DRIVE~1800~12000~' + nowSec + '~' + nowSec,
    'temp text projection must match the legacy session format');

  // Rollup commits the due sample into the master cache with exact DRIVE bucket.
  sandbox.cacheManager('ROLLUP_DUE_TEMP', { nowSec: nowSec });
  const route = readJsonStore(store, ROUTE_JSON);
  assert(route, 'TDS_Route_Cache.json must exist');
  assert.strictEqual(route.schemaVersion, 1, 'route cache schemaVersion must be 1');
  const routeKeys = Object.keys(route.entries);
  assert.strictEqual(routeKeys.length, 1, 'route cache must hold one entry');
  const entry = route.entries[routeKeys[0]];
  assert.strictEqual(entry.originCell, '51.9,-2.1', 'entry originCell');
  assert.strictEqual(entry.mode, 'DRIVE', 'entry mode');
  assert.strictEqual(entry.bucket, 1333, 'DRIVE bucket must be the exact tod');
  assert.strictEqual(entry.dayClass, 0, 'entry dayClass must be 0 (Tuesday)');
  assert.strictEqual(entry.meanDurationSecs, 1800, 'entry meanDurationSecs');
  assert.strictEqual(entry.sampleCount, 1, 'entry sampleCount');
  assert.strictEqual(entry.m2, 0, 'entry m2');
  assert.strictEqual(entry.distanceMiles, 12000, 'entry distance');
  assert.strictEqual(entry.createdAt, nowSec, 'entry createdAt');
  assert.strictEqual(entry.updatedAt, nowSec, 'entry updatedAt');
  assert.strictEqual(entry.expiresAt, nowSec + 30 * 86400, 'entry master TTL must be 30 days');
  assert.strictEqual(store.files[ROUTE_TEXT], '51.9,-2.1~51.5,-2.0~DRIVE~1800~12000~' + nowSec + '~0~1333~0~1',
    'route text projection must match the legacy rollup bytes');
  assert.strictEqual(store.files[TEMP_TEXT], '', 'consumed temp sample must leave an empty temp cache');

  // WALK: bucket is null in JSON; the text projection stays parseable and the
  // reader-visible mean is preserved (WALK tod is a dead text field).
  sandbox.cacheManager('SESSION_CACHE_UPSERT', {
    origin: '52.0,-2.3', destination: '51.7,-2.1', mode: 'WALK',
    durationSecs: 900, distanceMeters: 1100, apiUnix: nowSec, targetUnix: nowSec,
    emittedAt: nowSec
  });
  sandbox.cacheManager('ROLLUP_DUE_TEMP', { nowSec: nowSec });
  const route2 = readJsonStore(store, ROUTE_JSON);
  const walkEntry = Object.keys(route2.entries).map(function (k) { return route2.entries[k]; })
    .filter(function (e) { return e.mode === 'WALK'; })[0];
  assert(walkEntry, 'WALK entry must exist');
  assert.strictEqual(walkEntry.bucket, null, 'WALK bucket must be null');
  assert.strictEqual(walkEntry.meanDurationSecs, 900, 'WALK mean must be preserved');
  const walkText = store.files[ROUTE_TEXT].split('|').filter(function (l) { return l.indexOf('WALK') !== -1; })[0];
  assert(walkText && walkText.split('~').length === 10, 'WALK text entry must stay 10-field parseable');
  assert.strictEqual(parseInt(walkText.split('~')[3], 10), 900, 'readers must select the WALK mean 900');

  // Order cache schema + ENQUEUE_REORDER re-stage.
  const { sandbox: s2, store: st2 } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  const orderResult = s2.cacheManager('ORDER_CACHE_UPSERT', {
    clusterKey: '51.9,-2.1|dest1|wp1,wp2', orderedEventIds: ['wp2', 'wp1'],
    generationId: 'gen:1700000000:ab12', source: 'API_Parser', emittedAt: nowSec
  });
  assert(orderResult.indexOf('OK') === 0, 'ORDER_CACHE_UPSERT must succeed: ' + orderResult);
  const order = readJsonStore(st2, ORDER_JSON);
  assert(order && order.schemaVersion === 1, 'order cache must exist with schemaVersion 1');
  assert.strictEqual(order.entries['51.9,-2.1|dest1|wp1,wp2'].result.join(','), 'wp2,wp1', 'order result must be stored');
  assert.strictEqual(st2.files[ORDER_TEXT], '51.9,-2.1|dest1|wp1,wp2|wp2,wp1', 'order text projection must match the legacy line format');
  assert.strictEqual(s2.local('par1'), 'ENQUEUE_REORDER', 'manager must re-stage ENQUEUE_REORDER');
  assert.deepStrictEqual(JSON.parse(s2.local('par2')).orderedEventIds, ['wp2', 'wp1'], 're-staged reorder must carry the ordered ids');

  // Request state schema.
  const { sandbox: s3, store: st3 } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  const reqResult = s3.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: 'gen:1700000000:ab12', clusterId: '51.9,-2.1|dest1', requestId: 'req:1700000000:abcd', emittedAt: nowSec
  });
  assert(reqResult.indexOf('OK') === 0, 'REQUEST_STATE_REGISTER must succeed: ' + reqResult);
  const reqState = readJsonStore(st3, REQUEST_JSON);
  assert(reqState && reqState.schemaVersion === 1, 'request state must exist with schemaVersion 1');
  assert.strictEqual(reqState.latestByCluster['51.9,-2.1|dest1'].requestId, 'req:1700000000:abcd', 'latest request must be recorded');
} catch (e) {
  fail('JSON schema section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Welford parity through Alpha (behavior preserved) ----------

try {
  // A: fresh entry from a due session measurement.
  let store = commitViaAlpha(sample(1800, nowSec), {}, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~1800~12000~' + nowSec + '~0~1333~0~1',
    tempText: ''
  });
  // B: Welford update (n 1 -> 2): mean 1950, m2 45000.
  store = commitViaAlpha(sample(2100, nowSec + 1), store.files, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~1950~12000~' + nowSec + '~45000~1333~0~2',
    tempText: ''
  });
  // C: ratio outlier reset (n 2 -> 1): 7000 > 3 * 1950.
  store = commitViaAlpha(sample(7000, nowSec + 2), store.files, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~1950~12000~' + nowSec + '~45000~1333~0~1',
    tempText: ''
  });
  // D: update (n 1 -> 2): mean 1975, m2 46250.
  store = commitViaAlpha(sample(2000, nowSec + 3), store.files, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~1975~12000~' + nowSec + '~46250~1333~0~2',
    tempText: ''
  });
  // E: update (n 2 -> 3): mean 1983, m2 46667.
  store = commitViaAlpha(sample(2000, nowSec + 4), store.files, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~1983~12000~' + nowSec + '~46667~1333~0~3',
    tempText: ''
  });
  // F: z-score path (n 3 -> 4): z = 117/152.75 < 2.0 -> accepted; mean 2012, m2 56934.
  store = commitViaAlpha(sample(2100, nowSec + 5), store.files, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~2012~12000~' + nowSec + '~56934~1333~0~4',
    tempText: ''
  });
  // G: un-expired samples stay in the temp cache (keep-until-event semantics).
  const keep = commitViaAlpha(Object.assign(sample(2400, nowSec + 6), { targetUnix: nowSec + 3600 }), store.files, {
    routeText: '51.9,-2.1~51.5,-2.0~DRIVE~2012~12000~' + nowSec + '~56934~1333~0~4',
    tempText: '51.9,-2.1~51.5,-2.0~DRIVE~2400~12000~' + (nowSec + 6) + '~' + (nowSec + 3600)
  });
  assert(keep, 'keep-until-event run must complete');
} catch (e) {
  fail('Welford parity section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Multi-writer fix: Alpha + API_Parser no longer write caches ----------

try {
  // Alpha run with a seeded temp sample: no direct cache writes, only the stage.
  const { sandbox, store } = createSandbox({
    globals: { TIMEMS: String(nowSec * 1000), Auto_Base_Hours: '3' },
    files: { [TEMP_TEXT]: '51.9,-2.1~51.5,-2.0~DRIVE~1800~12000~' + nowSec + '~' + nowSec, [ROUTE_TEXT]: '' },
    nowMs: nowSec * 1000
  });
  runScript(ALPHA, sandbox, store);
  if (store.runError) throw new Error('Alpha crashed with guards: ' + JSON.stringify(store.runError));
  assert(!store.writeLog.some(function (w) { return w.path === TEMP_TEXT || w.path === ROUTE_TEXT; }),
    'Alpha must not write Temp_Route_Cache.txt or RouteCache.txt directly');
  assert.strictEqual(sandbox.local('par1'), 'ROLLUP_DUE_TEMP', 'Alpha must stage ROLLUP_DUE_TEMP');

  // API_Parser route mode: no direct temp write, stages SESSION_CACHE_UPSERT.
  const routePayload = { routes: [{ duration: '1800s', distanceMeters: 12000 }] };
  const { sandbox: ap, store: apStore } = createSandbox({
    locals: { api_route_mode: '', par11: '51.9,-2.1', par12: '51.5,-2.0', par13: 'DRIVE', par14: String(nowSec) },
    files: { [DATA + 'temp_payload.json']: JSON.stringify(routePayload) },
    nowMs: nowSec * 1000
  });
  runScript(API_PARSER, ap, apStore);
  if (apStore.runError) throw new Error('API_Parser crashed with guards: ' + JSON.stringify(apStore.runError));
  assert(!apStore.writeLog.some(function (w) { return w.path === TEMP_TEXT; }),
    'API_Parser must not write Temp_Route_Cache.txt directly');
  assert.strictEqual(ap.local('par1'), 'SESSION_CACHE_UPSERT', 'API_Parser must stage SESSION_CACHE_UPSERT');
  const stagedSample = JSON.parse(ap.local('par2'));
  assert.strictEqual(stagedSample.origin, '51.9,-2.1', 'staged sample origin');
  assert.strictEqual(stagedSample.durationSecs, 1800, 'staged sample duration');
  const upsert = ap.cacheManager('SESSION_CACHE_UPSERT', stagedSample);
  assert(upsert.indexOf('OK') === 0, 'manager must accept the staged sample: ' + upsert);

  // API_Parser cluster mode: no direct order write, stages ORDER_CACHE_UPSERT.
  const cluster = { waypoints: [{ id: 'wp1' }, { id: 'wp2' }], destination: { id: 'dest1' } };
  const clusterPayload = { routes: [{ optimizedIntermediateWaypointIndex: [1, 0] }] };
  const { sandbox: ac, store: acStore } = createSandbox({
    locals: { api_route_mode: 'CLUSTER', par1: JSON.stringify(cluster), par11: '', par12: '', par13: '', par14: '' },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: 'gen:1700000000:ab12' },
    files: { [DATA + 'TDS_Reorder_Commands.json']: '[]', [DATA + 'temp_payload.json']: JSON.stringify(clusterPayload) },
    nowMs: nowSec * 1000
  });
  runScript(API_PARSER, ac, acStore);
  if (acStore.runError) throw new Error('API_Parser cluster crashed with guards: ' + JSON.stringify(acStore.runError));
  assert(!acStore.writeLog.some(function (w) { return w.path === ORDER_TEXT; }),
    'API_Parser must not write TDS_Order_Cache.txt directly');
  assert.strictEqual(ac.local('par1'), 'ORDER_CACHE_UPSERT', 'API_Parser must stage ORDER_CACHE_UPSERT');
} catch (e) {
  fail('multi-writer fix section threw: ' + (e && e.message ? e.message : e));
}

// ---------- EVT codes (REQ-5LOG-1) ----------

try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  sandbox.cacheManager('SESSION_CACHE_UPSERT', {
    origin: '51.9,-2.1', destination: '51.5,-2.0', mode: 'DRIVE',
    durationSecs: 1800, distanceMeters: 12000, apiUnix: nowSec, targetUnix: nowSec, emittedAt: nowSec
  });
  const mutated = store.flashLog.map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } })
    .filter(function (l) { return l && l.code === 'ROUTE_CACHE_MUTATED'; });
  assert(mutated.length >= 1, 'a successful mutation must log ROUTE_CACHE_MUTATED');
  const log = mutated[0];
  assert.strictEqual(log.component, 'Route_Cache_Manager', 'LOG-17 component');
  assert.strictEqual(log.severity, 'info', 'LOG-17 severity');
  assert.strictEqual(typeof log.timestamp, 'number', 'LOG-17 timestamp');
  assert('generationId' in log && 'tripId' in log && 'details' in log, 'LOG-17 must carry all fields');

  const rejected = sandbox.cacheManager('SESSION_CACHE_UPSERT', { origin: '', destination: 'x', mode: 'DRIVE', durationSecs: 0 });
  assert(rejected.indexOf('ERROR') === 0, 'invalid sample must be rejected: ' + rejected);
  const rejectLog = store.flashLog.map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } })
    .filter(function (l) { return l && l.code === 'CACHE_ENTRY_REJECTED'; });
  assert(rejectLog.length >= 1, 'a rejected entry must log CACHE_ENTRY_REJECTED');
} catch (e) {
  fail('EVT code section threw: ' + (e && e.message ? e.message : e));
}

// ---------- CACHE_READ accessor ----------

try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  sandbox.cacheManager('SESSION_CACHE_UPSERT', {
    origin: '51.9,-2.1', destination: '51.5,-2.0', mode: 'DRIVE',
    durationSecs: 1800, distanceMeters: 12000, apiUnix: nowSec, targetUnix: nowSec, emittedAt: nowSec
  });
  sandbox.cacheManager('ROLLUP_DUE_TEMP', { nowSec: nowSec });
  const readResult = sandbox.cacheManager('CACHE_READ', { kind: 'route' });
  assert(readResult.indexOf('OK') === 0, 'CACHE_READ must succeed: ' + readResult);
  const cache = JSON.parse(sandbox.local('cache_read_result'));
  assert.strictEqual(cache.schemaVersion, 1, 'CACHE_READ must return the route cache');
  assert.strictEqual(Object.keys(cache.entries).length, 1, 'CACHE_READ must expose the committed entry');

  // REQ-5CACHE-2: CACHE_READ MUST NOT surface expired or nonpositive entries
  // (they are misses). Seed a JSON with one valid + one expired + one
  // nonpositive route entry; read back only the valid one.
  const seeded = createSandbox({
    files: {
      [ROUTE_JSON]: JSON.stringify({ schemaVersion: 1, updatedAt: nowSec, entries: {
        '1,1~~2,2~~DRIVE~~900~~0': {
          originCell: '1,1', destinationCell: '2,2', mode: 'DRIVE', dayClass: 0, bucket: 900,
          meanDurationSecs: 600, sampleCount: 1, m2: 0, distanceMiles: 100,
          createdAt: nowSec - 60, updatedAt: nowSec - 60, expiresAt: nowSec + RCM_TEST_FUTURE
        },
        '3,3~~4,4~~DRIVE~~900~~0': {
          originCell: '3,3', destinationCell: '4,4', mode: 'DRIVE', dayClass: 0, bucket: 900,
          meanDurationSecs: 700, sampleCount: 1, m2: 0, distanceMiles: 100,
          createdAt: nowSec - 400000, updatedAt: nowSec - 400000, expiresAt: nowSec - 60
        },
        '5,5~~6,6~~DRIVE~~900~~0': {
          originCell: '5,5', destinationCell: '6,6', mode: 'DRIVE', dayClass: 0, bucket: 900,
          meanDurationSecs: 0, sampleCount: 1, m2: 0, distanceMiles: 100,
          createdAt: nowSec - 60, updatedAt: nowSec - 60, expiresAt: nowSec + RCM_TEST_FUTURE
        }
      } })
    },
    nowMs: nowSec * 1000
  });
  const read2 = seeded.sandbox.cacheManager('CACHE_READ', { kind: 'route' });
  assert(read2.indexOf('OK') === 0, 'CACHE_READ must succeed on seeded cache: ' + read2);
  const filtered = JSON.parse(seeded.sandbox.local('cache_read_result'));
  const keptKeys = Object.keys(filtered.entries || {});
  assert.strictEqual(keptKeys.length, 1, 'CACHE_READ must drop expired + nonpositive entries (got ' + keptKeys.length + ': ' + keptKeys.join(',') + ')');
  assert(keptKeys[0].indexOf('1,1~~2,2') === 0, 'CACHE_READ must keep only the valid entry');
  const rejectedLogs = (seeded.store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } })
    .filter(function (l) { return l && l.code === 'CACHE_ENTRY_REJECTED'; });
  assert(rejectedLogs.length >= 2, 'expired + nonpositive drops must log CACHE_ENTRY_REJECTED (got ' + rejectedLogs.length + ')');

  // REQ-5CACHE-3: malformed and key/bucket-mismatched entries are also misses.
  const malformed = createSandbox({
    files: {
      [ROUTE_JSON]: JSON.stringify({ schemaVersion: 1, updatedAt: nowSec, entries: {
        'malformed~~key~~DRIVE~~900~~0': { originCell: '1,1' },
        '1,1~~2,2~~DRIVE~~900~~0': {
          originCell: '1,1', destinationCell: '2,2', mode: 'DRIVE', dayClass: 0, bucket: 900,
          meanDurationSecs: 600, sampleCount: 1, m2: 0, distanceMiles: 100,
          createdAt: nowSec - 60, updatedAt: nowSec - 60, expiresAt: nowSec + RCM_TEST_FUTURE
        },
        '9,9~~8,8~~WALK~~null~~0': {
          originCell: '9,9', destinationCell: '8,8', mode: 'WALK', dayClass: 0, bucket: 900,
          meanDurationSecs: 700, sampleCount: 1, m2: 0, distanceMiles: 100,
          createdAt: nowSec - 60, updatedAt: nowSec - 60, expiresAt: nowSec + RCM_TEST_FUTURE
        }
      } })
    },
    nowMs: nowSec * 1000
  });
  const read3 = malformed.sandbox.cacheManager('CACHE_READ', { kind: 'route' });
  assert(read3.indexOf('OK') === 0, 'CACHE_READ must succeed on malformed cache: ' + read3);
  const filtered3 = JSON.parse(malformed.sandbox.local('cache_read_result'));
  const kept3 = Object.keys(filtered3.entries || {});
  assert.strictEqual(kept3.length, 1, 'CACHE_READ must drop malformed + key-mismatch entries (got ' + kept3.length + ': ' + kept3.join(',') + ')');
  assert(kept3[0].indexOf('1,1~~2,2') === 0, 'CACHE_READ must keep only the structurally valid, key-consistent entry');
  const rejectCount3 = (malformed.store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } })
    .filter(function (l) { return l && l.code === 'CACHE_ENTRY_REJECTED'; }).length;
  assert(rejectCount3 >= 2, 'malformed + mismatch drops must log CACHE_ENTRY_REJECTED (got ' + rejectCount3 + ')');

  // REQ-5CACHE-3: malformed temp and order entries must also be misses.
  const badTempKey = '1,1~~2,2~~DRIVE~~' + nowSec;
  const malformedTemp = createSandbox({
    files: {
      [TEMP_JSON]: JSON.stringify({ schemaVersion: 1, updatedAt: nowSec, entries: {
        [badTempKey]: { originCell: '1,1' },
        [badTempKey + 'x']: { originCell: '1,1', destinationCell: '2,2', mode: 'DRIVE', meanDurationSecs: 900, sampleCount: 1, m2: 0, distanceMiles: 50, apiUnix: nowSec, targetUnix: nowSec, createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + RCM_TEST_FUTURE }
      } })
    },
    nowMs: nowSec * 1000
  });
  const readT = malformedTemp.sandbox.cacheManager('CACHE_READ', { kind: 'temp' });
  assert(readT.indexOf('OK') === 0, 'CACHE_READ temp must succeed: ' + readT);
  const tempFiltered = JSON.parse(malformedTemp.sandbox.local('cache_read_result'));
  assert.strictEqual(Object.keys(tempFiltered.entries || {}).length, 0, 'malformed + key-mismatch temp entries must be dropped');

  // Temp entries missing dayClass or bucket are also misses.
  const missingDayClass = createSandbox({
    files: {
      [TEMP_JSON]: JSON.stringify({ schemaVersion: 1, updatedAt: nowSec, entries: {
        [badTempKey]: { originCell: '1,1', destinationCell: '2,2', mode: 'DRIVE', meanDurationSecs: 900, sampleCount: 1, m2: 0, distanceMiles: 50, apiUnix: nowSec, targetUnix: nowSec, createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + RCM_TEST_FUTURE },
        [badTempKey + 'y']: { originCell: '1,1', destinationCell: '2,2', mode: 'DRIVE', dayClass: 0, meanDurationSecs: 900, sampleCount: 1, m2: 0, distanceMiles: 50, apiUnix: nowSec, targetUnix: nowSec, createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + RCM_TEST_FUTURE }
      } })
    },
    nowMs: nowSec * 1000
  });
  const readT2 = missingDayClass.sandbox.cacheManager('CACHE_READ', { kind: 'temp' });
  assert(readT2.indexOf('OK') === 0, 'CACHE_READ temp must succeed (missing dayClass): ' + readT2);
  const tempFiltered2 = JSON.parse(missingDayClass.sandbox.local('cache_read_result'));
  assert.strictEqual(Object.keys(tempFiltered2.entries || {}).length, 0, 'temp entries missing dayClass or bucket must be dropped');
  const badOrderKey = 'c1|d1|wp1,wp2';
  const malformedOrder = createSandbox({
    files: {
      [ORDER_JSON]: JSON.stringify({ schemaVersion: 1, updatedAt: nowSec, entries: {
        [badOrderKey]: { clusterKey: badOrderKey, result: [], createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + RCM_TEST_FUTURE },
        [badOrderKey + 'x']: { clusterKey: badOrderKey, result: ['wp1', 5], createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + RCM_TEST_FUTURE }
      } })
    },
    nowMs: nowSec * 1000
  });
  const readO = malformedOrder.sandbox.cacheManager('CACHE_READ', { kind: 'order' });
  assert(readO.indexOf('OK') === 0, 'CACHE_READ order must succeed: ' + readO);
  const orderFiltered = JSON.parse(malformedOrder.sandbox.local('cache_read_result'));
  assert.strictEqual(Object.keys(orderFiltered.entries || {}).length, 0, 'empty-result + non-string-id order entries must be dropped');
} catch (e) {
  fail('CACHE_READ section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Legacy text migration + TTL pruning (PRUNE) ----------

try {
  // TTL prune: an expired JSON entry is dropped; fresh entries survive.
  const { sandbox, store } = createSandbox({
    files: {
      [ROUTE_JSON]: JSON.stringify({ schemaVersion: 1, updatedAt: nowSec - 100, entries: {
        'old~~key~~DRIVE~~900~~0': {
          originCell: '1,1', destinationCell: '2,2', mode: 'DRIVE', dayClass: 0, bucket: 900,
          meanDurationSecs: 500, sampleCount: 1, m2: 0, distanceMiles: 100,
          createdAt: nowSec - 31 * 86400, updatedAt: nowSec - 31 * 86400, expiresAt: nowSec - 86400
        }
      } })
    },
    nowMs: nowSec * 1000
  });
  const prune = sandbox.cacheManager('PRUNE', { nowSec: nowSec });
  assert(prune.indexOf('OK') === 0, 'PRUNE must succeed: ' + prune);
  const pruned = readJsonStore(store, ROUTE_JSON);
  assert(pruned, 'route cache must be persisted after PRUNE');
  assert(!pruned.entries['old~~key~~DRIVE~~900~~0'], 'expired entry must be pruned');

  // Legacy migration: text-only caches migrate into JSON on the first mutation.
  const legacyRoute = '52.0,-2.3~51.7,-2.1~DRIVE~1200~8000~' + (nowSec - 100) + '~500~1000~0~5';
  const legacyTemp = '52.0,-2.3~51.7,-2.1~DRIVE~1200~8000~' + (nowSec - 100) + '~' + (nowSec + 3600);
  const legacyOrder = '52.0,-2.3|dest2|wp1,wp2|wp2,wp1';
  const { sandbox: s2, store: st2 } = createSandbox({
    files: { [ROUTE_TEXT]: legacyRoute, [TEMP_TEXT]: legacyTemp, [ORDER_TEXT]: legacyOrder },
    nowMs: nowSec * 1000
  });
  const prune2 = s2.cacheManager('PRUNE', { nowSec: nowSec });
  assert(prune2.indexOf('OK') === 0, 'PRUNE must succeed on legacy caches: ' + prune2);
  const route = readJsonStore(st2, ROUTE_JSON);
  assert(route, 'route cache must be persisted after PRUNE');
  const migrated = Object.keys(route.entries).map(function (k) { return route.entries[k]; })
    .filter(function (e) { return e.originCell === '52.0,-2.3'; })[0];
  assert(migrated, 'legacy RouteCache.txt must migrate into the JSON cache');
  assert.strictEqual(migrated.meanDurationSecs, 1200, 'migrated mean must be preserved');
  assert.strictEqual(migrated.sampleCount, 5, 'migrated sampleCount must be preserved');
  assert.strictEqual(migrated.bucket, 1000, 'migrated DRIVE bucket must be the tod');
  const temp = readJsonStore(st2, TEMP_JSON);
  assert(temp && Object.keys(temp.entries).length === 1, 'legacy temp sample must migrate');
  const order = readJsonStore(st2, ORDER_JSON);
  assert(order && order.entries['52.0,-2.3|dest2|wp1,wp2'], 'legacy order line must migrate');
} catch (e) {
  fail('migration/PRUNE section threw: ' + (e && e.message ? e.message : e));
}

if (failures > 0) {
  console.log('FAIL: Route Cache Manager — ' + failures + ' assertion group(s) failed');
  process.exit(1);
}
console.log('PASS: Route Cache Manager — ownership guard, JSON schemas, Welford parity, multi-writer fix, EVT codes, CACHE_READ, migration + TTL prune');
