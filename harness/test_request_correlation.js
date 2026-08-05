// Phase 5 Slice C (REQ-5REQID-1/2, SCN-5REQID-1..3, REQ-5LOG-1): request
// correlation + stale-response rejection.
//
// Covered:
//   Builder stamping     — API_JSON_Build stamps {generationId, clusterId,
//                           requestId} into a correlation envelope and stages
//                           REQUEST_STATE_REGISTER for the Route Cache Manager
//                           BEFORE the wire body is produced.
//   Wire-payload purity  — api_request_body sent to Google Routes carries NO
//                           correlation fields (origin/destination/travelMode/
//                           intermediates only).
//   Callback retention   — temp_payload.json carries {correlation, response}
//                           (design contract) or the raw response with the
//                           builder's api_correlation local.
//   Exact correlation    — API_Parser requires generationId === active
//                           generation AND a latest-by-cluster record whose
//                           requestId/generationId match exactly.
//   Stale no-op          — any missing/mismatched field logs
//                           STALE_API_RESPONSE_DISCARDED (LOG-17) and performs
//                           NO cache/reorder mutation.
//   Latest wins          — a superseded requestId (a newer registration for the
//                           same cluster) is rejected; the manager record is
//                           overwritten, and records from other generations are
//                           pruned on registration.
//
// MUST FAIL on master: no stamping, no registration, no correlation check, and
// no STALE_API_RESPONSE_DISCARDED anywhere in the codebase.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const DATA = "Tasker/Tesla/Data/";
const nowSec = 1700000000; // 2023-11-14T22:13:20Z
const GEN = 'gen:1700000000:ab12';
const BUILDER = path.resolve(__dirname, '..', 'API_JSON_Build.js');
const PARSER = path.resolve(__dirname, '..', 'API_Parser.js');
const REQUEST_JSON = DATA + 'TDS_Route_Request_State.json';
const TEMP_PAYLOAD = DATA + 'temp_payload.json';

let failures = 0;
function fail(msg) {
  failures += 1;
  console.log('FAIL: Request Correlation — ' + msg);
}

function readJsonStore(store, filePath) {
  const raw = store.files[filePath] || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function clusterFixture() {
  return {
    destination: { id: 'dest1', coords: '51.5,-2.0' },
    waypoints: [
      { id: 'wp1', coords: '51.45,-2.05' },
      { id: 'wp2', coords: '51.55,-2.15' }
    ]
  };
}

function expectedClusterWire(uLoc) {
  const u = uLoc.split(',');
  return {
    origin: { location: { latLng: { latitude: parseFloat(u[0]), longitude: parseFloat(u[1]) } } },
    destination: { location: { latLng: { latitude: 51.5, longitude: -2.0 } } },
    travelMode: 'DRIVE',
    optimizeWaypointOrder: true,
    intermediates: [
      { location: { latLng: { latitude: 51.45, longitude: -2.05 } } },
      { location: { latLng: { latitude: 51.55, longitude: -2.15 } } }
    ]
  };
}

function parseLogs(store) {
  return (store.flashLog || []).map(function (msg) {
    try { return JSON.parse(msg); } catch (e) { return null; }
  }).filter(function (o) { return o !== null; });
}

function logsWithCode(store, code) {
  return parseLogs(store).filter(function (l) { return l.code === code; });
}

// Run builder + manager registration on one sandbox; returns the staged
// correlation read back from the builder so the callback can be built.
function runRegisteredClusterFlow() {
  const cluster = clusterFixture();
  const { sandbox, store } = createSandbox({
    locals: { par1: JSON.stringify(cluster) },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: GEN },
    nowMs: nowSec * 1000
  });
  runScript(BUILDER, sandbox, store);
  if (store.runError) throw new Error('API_JSON_Build crashed: ' + JSON.stringify(store.runError));
  const correlation = JSON.parse(sandbox.local('api_correlation'));
  const payload = JSON.parse(sandbox.local('par2'));
  const result = sandbox.cacheManager('REQUEST_STATE_REGISTER', payload);
  assert(result.indexOf('OK') === 0, 'REQUEST_STATE_REGISTER must succeed: ' + result);
  return { sandbox: sandbox, store: store, correlation: correlation, cluster: cluster };
}

// ---------- (a)+(b) Builder stamps IDs; wire payload stays pure ----------

try {
  const cluster = clusterFixture();
  const { sandbox, store } = createSandbox({
    locals: { par1: JSON.stringify(cluster) },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: GEN },
    nowMs: nowSec * 1000
  });
  runScript(BUILDER, sandbox, store);
  if (store.runError) throw new Error('API_JSON_Build crashed: ' + JSON.stringify(store.runError));

  assert.strictEqual(sandbox.local('api_route_mode'), 'CLUSTER', 'builder must keep api_route_mode CLUSTER');
  assert.strictEqual(sandbox.local('par1'), 'REQUEST_STATE_REGISTER', 'builder must stage REQUEST_STATE_REGISTER for the manager');

  const correlation = JSON.parse(sandbox.local('api_correlation'));
  assert.strictEqual(correlation.generationId, GEN, 'correlation must carry the active generation');
  assert.strictEqual(correlation.clusterId, '51.9,-2.1|dest1|wp1,wp2', 'correlation clusterId must be destination + ordered waypoint ids');
  assert(/^req:\d+:[\da-f]{4}$/.test(correlation.requestId), 'requestId must be req:<unixSec>:<4hex>, got ' + correlation.requestId);

  const regPayload = JSON.parse(sandbox.local('par2'));
  assert.strictEqual(regPayload.generationId, GEN, 'register payload generationId');
  assert.strictEqual(regPayload.clusterId, correlation.clusterId, 'register payload clusterId');
  assert.strictEqual(regPayload.requestId, correlation.requestId, 'register payload requestId');
  assert.strictEqual(regPayload.emittedAt, nowSec, 'register payload emittedAt must be the unix second');
  assert.strictEqual(sandbox.local('api_cluster_json'), JSON.stringify(cluster), 'builder must preserve the cluster for the parser');

  // Wire purity: api_request_body is exactly the Google Routes projection.
  const wireStr = sandbox.local('api_request_body');
  ['generationId', 'clusterId', 'requestId', 'req:'].forEach(function (k) {
    assert(wireStr.indexOf(k) === -1, 'wire payload must not contain ' + k);
  });
  assert.deepStrictEqual(JSON.parse(wireStr), expectedClusterWire('51.9,-2.1'), 'wire payload must be the pure Google Routes body');
} catch (e) {
  fail('builder stamping section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Manager records the latest request per cluster ----------

try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  const result = sandbox.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: GEN, clusterId: 'c1', requestId: 'req:1700000000:1111', emittedAt: nowSec
  });
  assert(result.indexOf('OK') === 0, 'register must succeed: ' + result);
  let state = readJsonStore(store, REQUEST_JSON);
  assert(state && state.schemaVersion === 1, 'request state must have schemaVersion 1');
  assert.strictEqual(state.latestByCluster['c1'].requestId, 'req:1700000000:1111', 'first registration recorded');

  // Latest wins: a newer registration for the same cluster overwrites.
  sandbox.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: GEN, clusterId: 'c1', requestId: 'req:1700000000:2222', emittedAt: nowSec + 1
  });
  state = readJsonStore(store, REQUEST_JSON);
  assert.strictEqual(state.latestByCluster['c1'].requestId, 'req:1700000000:2222', 'latest registration must win per cluster');
  assert.strictEqual(Object.keys(state.latestByCluster).length, 1, 'superseded record must be removed');

  // Generation pruning: a registration from another generation drops old-gen records.
  sandbox.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: 'gen:NEW:ffff', clusterId: 'c2', requestId: 'req:1700000000:3333', emittedAt: nowSec + 2
  });
  state = readJsonStore(store, REQUEST_JSON);
  assert(state.latestByCluster['c2'], 'new-generation record must be present');
  assert(!state.latestByCluster['c1'], 'records from other generations must be pruned on registration');
  const registered = logsWithCode(store, 'ROUTE_REQUEST_REGISTERED');
  assert(registered.length >= 3, 'each registration must log ROUTE_REQUEST_REGISTERED');
} catch (e) {
  fail('manager registration section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (c-valid)+(e) Exact match applies: cache + reorder staged ----------

try {
  const flow = runRegisteredClusterFlow();
  const { sandbox, store } = flow;
  const correlation = flow.correlation;

  const callback = {
    correlation: correlation,
    response: { routes: [{ optimizedIntermediateWaypointIndex: [1, 0] }] }
  };
  sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify(callback));
  runScript(PARSER, sandbox, store);
  if (store.runError) throw new Error('API_Parser crashed on accepted callback: ' + JSON.stringify(store.runError));

  assert.strictEqual(sandbox.local('par1'), 'ORDER_CACHE_UPSERT', 'accepted cluster response must stage ORDER_CACHE_UPSERT');
  const staged = JSON.parse(sandbox.local('par2'));
  assert.strictEqual(staged.clusterKey, '51.9,-2.1|dest1|wp1,wp2', 'staged clusterKey must match the correlation clusterId');
  assert.deepStrictEqual(staged.orderedEventIds, ['wp2', 'wp1'], 'optimized order must be staged');
  assert.strictEqual(staged.generationId, GEN, 'staged generation must match');
  const accepted = logsWithCode(store, 'ROUTE_RESPONSE_ACCEPTED');
  assert(accepted.length === 1, 'accepted callback must log ROUTE_RESPONSE_ACCEPTED exactly once');
  assert.strictEqual(accepted[0].component, 'API_Parser', 'LOG-17 component');
  assert(!store.writeLog.some(function (w) { return w.path.indexOf('TDS_Order_Cache') !== -1 || w.path.indexOf('Temp_Route_Cache') !== -1; }),
    'parser must not write cache files directly');
} catch (e) {
  fail('accepted correlation section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (d) Superseded requestId rejected: latest wins ----------

try {
  const cluster = clusterFixture();
  const { sandbox, store } = createSandbox({
    locals: { par1: JSON.stringify(cluster) },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: GEN },
    nowMs: nowSec * 1000
  });
  // Register req1, then req2 supersedes it for the same cluster.
  sandbox.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: GEN, clusterId: '51.9,-2.1|dest1|wp1,wp2', requestId: 'req:1700000000:aaaa', emittedAt: nowSec
  });
  sandbox.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: GEN, clusterId: '51.9,-2.1|dest1|wp1,wp2', requestId: 'req:1700000000:bbbb', emittedAt: nowSec + 1
  });
  // The callback still carries the OLD requestId (stale delivery).
  sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify({
    correlation: { generationId: GEN, clusterId: '51.9,-2.1|dest1|wp1,wp2', requestId: 'req:1700000000:aaaa' },
    response: { routes: [{ optimizedIntermediateWaypointIndex: [0, 1] }] }
  }));
  runScript(PARSER, sandbox, store);
  if (store.runError) throw new Error('API_Parser crashed on superseded callback: ' + JSON.stringify(store.runError));

  const stale = logsWithCode(store, 'STALE_API_RESPONSE_DISCARDED');
  assert(stale.length === 1, 'superseded callback must log STALE_API_RESPONSE_DISCARDED');
  const evt = stale[0];
  assert.strictEqual(evt.component, 'API_Parser', 'stale LOG-17 component');
  assert.strictEqual(evt.severity, 'warn', 'stale LOG-17 severity');
  assert(typeof evt.timestamp === 'number' && 'generationId' in evt && 'tripId' in evt && evt.details,
    'stale LOG-17 must carry timestamp/generationId/tripId/details');
  assert(sandbox.local('par1') !== 'ORDER_CACHE_UPSERT' && sandbox.local('par1') !== 'SESSION_CACHE_UPSERT',
    'stale callback must not stage cache/reorder commands (par1=' + sandbox.local('par1') + ')');
  assert(!store.writeLog.some(function (w) { return w.path.indexOf('TDS_Order_Cache') !== -1 || w.path.indexOf('Temp_Route_Cache') !== -1; }),
    'stale callback must not write cache files');
  assert.strictEqual(store.files[TEMP_PAYLOAD], '{}', 'stale callback staging must be consumed');
} catch (e) {
  fail('superseded rejection section threw: ' + (e && e.message ? e.message : e));
}

// ---------- (c-mismatch) Generation mismatch and unknown cluster rejected ----------

try {
  const { sandbox, store } = createSandbox({ files: {}, nowMs: nowSec * 1000 });
  sandbox.cacheManager('REQUEST_STATE_REGISTER', {
    generationId: GEN, clusterId: 'c1', requestId: 'req:1700000000:1111', emittedAt: nowSec
  });

  // Generation mismatch: correlation claims an old generation.
  sandbox.setGlobal('TDS_Active_Generation', GEN);
  sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify({
    correlation: { generationId: 'gen:OLD:0000', clusterId: 'c1', requestId: 'req:1700000000:1111' },
    response: { routes: [{ duration: '1800s', distanceMeters: 12000 }] }
  }));
  runScript(PARSER, sandbox, store);
  if (store.runError) throw new Error('API_Parser crashed on generation-mismatch callback: ' + JSON.stringify(store.runError));
  assert(logsWithCode(store, 'STALE_API_RESPONSE_DISCARDED').length === 1, 'generation mismatch must be discarded');
  assert(sandbox.local('par1') !== 'ORDER_CACHE_UPSERT' && sandbox.local('par1') !== 'SESSION_CACHE_UPSERT',
    'generation-mismatch callback must not stage cache/reorder commands');

  // Unknown cluster: no record for the claimed clusterId.
  sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify({
    correlation: { generationId: GEN, clusterId: 'zzz|zzz', requestId: 'req:1700000000:9999' },
    response: { routes: [{ duration: '1800s', distanceMeters: 12000 }] }
  }));
  runScript(PARSER, sandbox, store);
  if (store.runError) throw new Error('API_Parser crashed on unknown-cluster callback: ' + JSON.stringify(store.runError));
  assert(logsWithCode(store, 'STALE_API_RESPONSE_DISCARDED').length === 2, 'unknown cluster must be discarded');
  assert(sandbox.local('par1') !== 'ORDER_CACHE_UPSERT' && sandbox.local('par1') !== 'SESSION_CACHE_UPSERT',
    'unknown-cluster callback must not stage cache/reorder commands');
  assert(!store.writeLog.some(function (w) { return w.path.indexOf('TDS_Order_Cache') !== -1 || w.path.indexOf('Temp_Route_Cache') !== -1; }),
    'stale callbacks must not write cache files');
} catch (e) {
  fail('generation/unknown-cluster rejection section threw: ' + (e && e.message ? e.message : e));
}

// ---------- Standard A-to-B fork: stamps too; route-mode accept + stale ----------

try {
  const { sandbox, store } = createSandbox({
    locals: { par11: '51.9,-2.1', par12: '51.5,-2.0', par13: 'DRIVE', par14: String(nowSec) },
    globals: { TDS_Active_Generation: GEN },
    nowMs: nowSec * 1000
  });
  runScript(BUILDER, sandbox, store);
  if (store.runError) throw new Error('API_JSON_Build crashed on standard fork: ' + JSON.stringify(store.runError));

  assert.strictEqual(sandbox.local('par1'), 'REQUEST_STATE_REGISTER', 'standard fork must stage registration too');
  const correlation = JSON.parse(sandbox.local('api_correlation'));
  assert.strictEqual(correlation.clusterId, '51.9,-2.1|51.5,-2.0|DRIVE', 'standard clusterId must be origin|destination|mode');
  const wireStr = sandbox.local('api_request_body');
  ['generationId', 'clusterId', 'requestId'].forEach(function (k) {
    assert(wireStr.indexOf(k) === -1, 'standard wire payload must not contain ' + k);
  });

  const payload = JSON.parse(sandbox.local('par2'));
  assert.strictEqual(payload.clusterId, correlation.clusterId, 'standard register payload clusterId');
  const regResult = sandbox.cacheManager('REQUEST_STATE_REGISTER', payload);
  assert(regResult.indexOf('OK') === 0, 'standard registration must succeed: ' + regResult);

  // Route-mode accept via the local correlation path (HTTP writes the raw response).
  sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify({ routes: [{ duration: '1800s', distanceMeters: 12000 }] }));
  runScript(PARSER, sandbox, store);
  if (store.runError) throw new Error('API_Parser crashed on route accept: ' + JSON.stringify(store.runError));
  assert.strictEqual(sandbox.local('par1'), 'SESSION_CACHE_UPSERT', 'accepted route response must stage SESSION_CACHE_UPSERT');
  const sample = JSON.parse(sandbox.local('par2'));
  assert.strictEqual(sample.origin, '51.9,-2.1', 'staged sample origin');
  assert.strictEqual(sample.durationSecs, 1800, 'staged sample duration');
  assert(logsWithCode(store, 'ROUTE_RESPONSE_ACCEPTED').length === 1, 'route accept must log ROUTE_RESPONSE_ACCEPTED');

  // Route-mode stale: callback requestId never registered -> exact mismatch.
  sandbox.setLocal('api_correlation', JSON.stringify({
    generationId: GEN, clusterId: '51.9,-2.1|51.5,-2.0|DRIVE', requestId: 'req:1700000000:ffff'
  }));
  sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify({ routes: [{ duration: '900s', distanceMeters: 6000 }] }));
  runScript(PARSER, sandbox, store);
  if (store.runError) throw new Error('API_Parser crashed on route stale: ' + JSON.stringify(store.runError));
  assert(logsWithCode(store, 'STALE_API_RESPONSE_DISCARDED').length === 1, 'unregistered requestId must be discarded');
  assert(sandbox.local('par1') !== 'SESSION_CACHE_UPSERT' && sandbox.local('par1') !== 'ORDER_CACHE_UPSERT',
    'stale route callback must not stage cache commands');
} catch (e) {
  fail('standard-fork section threw: ' + (e && e.message ? e.message : e));
}

if (failures > 0) {
  console.log('FAIL: Request Correlation — ' + failures + ' assertion group(s) failed');
  process.exit(1);
}
console.log('PASS: Request Correlation — builder stamping, wire purity, exact correlation, latest-wins, stale no-op, LOG-17');
