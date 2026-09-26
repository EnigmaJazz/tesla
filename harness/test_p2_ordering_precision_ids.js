// P2 regression coverage for cacheable cluster ordering, route precision, and exact arrival IDs.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const GEN = 'gen:1700000000:ab12';
const CLUSTER_ID = '51.9,-2.1|dest1|wp1,wp2';
const REQUEST_ID = 'req_p2_ordering';
let failures = 0;
function fail(message) { failures += 1; console.log('FAIL: p2-ordering-precision-ids — ' + message); }
const PARSER = path.resolve(__dirname, '..', 'API_Parser.js');
const GATEKEEPER = path.resolve(__dirname, '..', 'Gatekeeper.js');
const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');

function parserRun(response, mode, cluster) {
  const locals = {
    api_route_mode: mode,
    api_cluster_json: cluster ? JSON.stringify(cluster) : '',
    api_duration_secs: '',
    api_distance_miles: '',
    api_transit_steps: '',
    par11: '51.9,-2.1', par12: '52.1,-2.2', par13: 'DRIVE', par14: String(nowSec + 3600)
  };
  const files = {
    [DATA + 'TDS_Route_Request_State.json']: JSON.stringify({
      schemaVersion: 1,
      latestByCluster: { [CLUSTER_ID]: { requestId: REQUEST_ID, generationId: GEN } }
    }),
    [DATA + 'temp_payload.json']: JSON.stringify({
      correlation: { generationId: GEN, clusterId: CLUSTER_ID, requestId: REQUEST_ID }, response: response
    })
  };
  const { sandbox, store } = createSandbox({ locals: locals, globals: { TDS_Active_Generation: GEN, User_Loc: '51.9,-2.1' }, files: files, nowMs: nowSec * 1000 });
  runScript(PARSER, sandbox, store);
  return { sandbox: sandbox, store: store };
}
function parsedLogs(store) {
  return (store.flashLog || []).map(function (line) { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean);
}

try {
  const cluster = { origin: '51.9,-2.1', waypoints: [{ id: 'wp1' }, { id: 'wp2' }], destination: { id: 'dest1' } };
  const noOptimization = parserRun({ error: { message: 'route unavailable' } }, 'CLUSTER', cluster);
  assert.strictEqual(noOptimization.store.runError, undefined, 'no-routes parser path must not throw');
  assert.strictEqual(noOptimization.sandbox.local('par1'), '', 'no optimization must leave no order-cache command staged');
  assert.strictEqual(noOptimization.sandbox.local('par2'), '', 'no optimization must leave no order-cache payload staged');
  const warning = parsedLogs(noOptimization.store).find(function (entry) { return entry.code === 'CLUSTER_ORDER_UNOPTIMIZED'; });
  assert(warning, 'no optimization must flash CLUSTER_ORDER_UNOPTIMIZED');
  assert.strictEqual(warning.severity, 'warn', 'optimization warning severity must be lowercase warn');
  assert.strictEqual(warning.details.clusterId, CLUSTER_ID, 'warning must identify the cluster');
  const optimized = parserRun({ routes: [{ optimizedIntermediateWaypointIndex: [1, 0] }] }, 'CLUSTER', cluster);
  assert.strictEqual(optimized.store.runError, undefined, 'optimized control must not throw');
  assert.strictEqual(optimized.sandbox.local('par1'), 'ORDER_CACHE_UPSERT', 'usable optimization must still stage order cache');
  assert.deepStrictEqual(JSON.parse(optimized.sandbox.local('par2')).orderedEventIds, ['wp2', 'wp1'], 'optimized control must retain API order');
} catch (e) { fail('B1: ' + e.message); }

try {
  const api = parserRun({ routes: [{ duration: '600s', distanceMeters: 50 }] }, 'DRIVE');
  assert.strictEqual(api.store.runError, undefined, 'short API route must not throw');
  const apiMetrics = JSON.parse(api.sandbox.local('api_return_json'));
  assert(Number(apiMetrics.distanceMiles) > 0, '50 m API route must serialize positive distanceMiles');
  const origin = '51.9,-2.1';
  const destination = '52.1,-2.2';
  const routeKey = origin + '~~' + destination + '~~WALK~~null~~0';
  const cache = { schemaVersion: 1, entries: {} };
  cache.entries[routeKey] = {
    originCell: origin, destinationCell: destination, mode: 'WALK', bucket: null, dayClass: 0,
    meanDurationSecs: 600, sampleCount: 1, m2: 0, distanceMiles: 50 / 1609.344,
    createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + 3600
  };
  function gateRun() {
    const result = createSandbox({
      locals: { par1: 'ignored', par11: origin, par12: destination, par13: 'WALK', par14: String(nowSec + 3600) },
      globals: { TDS_Active_Generation: GEN, Live_Traffic_Threshold: '7200' },
      files: { [DATA + 'TDS_Route_Cache.json']: JSON.stringify(cache) }, nowMs: nowSec * 1000
    });
    runScript(GATEKEEPER, result.sandbox, result.store);
    return result;
  }
  const gate = gateRun();
  assert.strictEqual(gate.store.runError, undefined, 'Gatekeeper cache-hit path must not throw');
  assert.strictEqual(gate.sandbox.local('cache_hit'), 'true', 'short route fixture must hit Gatekeeper cache');
  const cachedMetrics = JSON.parse(gate.sandbox.local('api_return_json'));
  assert(Number(cachedMetrics.distanceMiles) > 0, '50 m cache hit must serialize positive distanceMiles');
  const longApi = parserRun({ routes: [{ duration: '600s', distanceMeters: 2000 }] }, 'DRIVE');
  assert.strictEqual(JSON.parse(longApi.sandbox.local('api_return_json')).distanceMiles, '1.243', 'multi-kilometre API distance must retain its existing three-decimal value');
  cache.entries[routeKey].distanceMiles = 2000 / 1609.344;
  const longGate = gateRun();
  assert.strictEqual(JSON.parse(longGate.sandbox.local('api_return_json')).distanceMiles, '1.243', 'multi-kilometre cache value must be unchanged at three decimals');
} catch (e) { fail('B2: ' + e.message); }

function compilerRun(previousEventId) {
  const currentId = 'current_kx8f00';
  const master = [
    { id: previousEventId, start: nowSec - 100, end: nowSec + 100, deadline: nowSec + 2000, duration: 3600, title: 'Prior', desc: '', loc: 'Prior', coords: '52.0,-2.0' },
    { id: currentId, start: nowSec + 7200, end: nowSec + 10800, duration: 3600, title: 'Current', desc: '', loc: 'Current', coords: '52.1,-2.2' }
  ];
  const previousLeg = { targetEventId: previousEventId, targetTitle: 'Prior', targetCoords: '52.0,-2.0', mode: 'DRIVE', departUnix: nowSec - 1000, arriveUnix: nowSec - 500, durationSecs: 500, distanceMiles: 1 };
  const row = makeTypedRow({
    rowType: 'EVENT', title: 'Current', coords: '52.1,-2.2', mode: 'DRIVE', displayTime: nowSec + 7200, departTime: nowSec + 7200,
    apiTimeType: 'DEPART', apiTimeUnix: nowSec + 7200, evId: currentId, evLoc: 'Current', engineLateMins: 0,
    currentLegStable: false, dropinStatusFlag: 'none', safeDesc: '', adHoc: [], routeDurationSecs: 600, routeDistanceMiles: 5,
    departurePolicy: 'ASAP', planningDay: '2026-09-24', originSource: 'LIVE_BASE'
  });
  const { sandbox, store } = createSandbox({
    locals: { block_queue: makeEnvelope([row]), api_duration_secs: '600', api_distance_miles: '5', api_transit_steps: '', virtual_time: String(nowSec) },
    globals: { TDS_Active_Generation: GEN, User_At_Base: 'true', User_Loc: '51.9,-2.1', Arrival_Buffer_Mins: '5', Departure_Buffer_Mins: '5' },
    files: { [DATA + 'TDS_Master.json']: JSON.stringify(master), [DATA + 'Itin_Master.json']: JSON.stringify([previousLeg]), [DATA + 'TDS_Overrides.json']: '{}' },
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  return store;
}
function publishedCurrent(store) {
  const manifest = JSON.parse(store.files[DATA + 'TDS_Run_Manifest.json']);
  return JSON.parse(store.files[manifest.itineraryPath]).find(function (leg) { return leg.targetEventId === 'current_kx8f00'; });
}
try {
  // Alpha.js constructs the real arrival ID as the occurrence ID plus the exact "_IN" suffix.
  const decoyStore = compilerRun('dinner_IN_city_kx8f00');
  assert.strictEqual(decoyStore.runError, undefined, 'decoy Compiler path must not throw');
  const decoyCurrent = publishedCurrent(decoyStore);
  assert(decoyCurrent, 'decoy follow-up leg must publish');
  assert.strictEqual(decoyCurrent.departUnix, nowSec + 400, 'an ID containing _IN but not ending in _IN must use event end plus buffer');
  const arrivalStore = compilerRun('abc123_kx8f00_IN');
  assert.strictEqual(arrivalStore.runError, undefined, 'real arrival Compiler path must not throw');
  const arrivalCurrent = publishedCurrent(arrivalStore);
  assert(arrivalCurrent, 'real-arrival follow-up leg must publish');
  assert.strictEqual(arrivalCurrent.departUnix, nowSec + 2300, 'exact _IN arrival must use its deadline plus departure buffer as hardFloor');
} catch (e) { fail('B3: ' + e.message); }

if (failures > 0) { console.log('FAIL: p2-ordering-precision-ids — ' + failures + ' scenario(s) failed'); process.exit(1); }
console.log('PASS: p2-ordering-precision-ids — ordering retries, route precision, and exact arrival event IDs');
