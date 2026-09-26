// P1-7: direct coverage for the API_Parser metrics-rejection path. Every case
// carries a VALID correlation so the rejection is attributable to the metrics
// (never the stale-response guard). A rejected result must stage an empty
// api_return_json, clear the derived metric locals (so a stale positive value
// can never survive into the Compiler), and stage NO cache command.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const PARSER = path.resolve(__dirname, '..', 'API_Parser.js');
const GEN = 'gen:1700000000:ab12';
const CLUSTER_ID = '51.9,-2.1|dest1|wp1,wp2';
const REQUEST_ID = 'req_metrics';

const baseLocals = {
  api_route_mode: 'DRIVE',
  // Stale positive metrics: a rejected case must clear all three.
  api_duration_secs: '9999',
  api_distance_miles: '8888',
  api_transit_steps: 'STALE_STEPS',
  par11: '51.9,-2.1',
  par12: '52.1,-2.2',
  par13: 'DRIVE',
  par14: String(nowSec + 3600)
};

function run(response, opts) {
  opts = opts || {};
  const files = {
    [DATA + 'TDS_Route_Request_State.json']: JSON.stringify({
      schemaVersion: 1,
      latestByCluster: { [CLUSTER_ID]: { requestId: REQUEST_ID, generationId: GEN } }
    }),
    [DATA + 'temp_payload.json']: JSON.stringify({
      correlation: { generationId: GEN, clusterId: CLUSTER_ID, requestId: REQUEST_ID },
      response: response
    })
  };
  const locals = Object.assign({}, baseLocals, opts.locals || {});
  const globals = Object.assign({ TDS_Active_Generation: GEN, User_Loc: '51.9,-2.1' }, opts.globals || {});
  if (opts.omitRequestState) delete files[DATA + 'TDS_Route_Request_State.json'];
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: Object.assign(files, opts.files || {}), failures: opts.failures || {}, nowMs: nowSec * 1000 });
  runScript(PARSER, sandbox, store);
  return store;
}
function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function hasCode(store, code) {
  return logs(store).some(function (l) { return l.code === code; });
}
function route(duration, distanceMeters) {
  const r = { legs: [{}] };
  if (duration !== undefined) r.duration = duration;
  if (distanceMeters !== undefined) r.distanceMeters = distanceMeters;
  return { routes: [r] };
}

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: api-parser — ' + msg); }

// A REJECTED metric pair: API_METRICS_INVALID, empty api_return_json, no cache
// command, all three derived metric locals cleared.
function assertRejected(name, response) {
  const store = run(response);
  if (store.runError) { fail(name + ': parser threw: ' + store.runError.message); return; }
  assert(hasCode(store, 'API_METRICS_INVALID'), name + ': API_METRICS_INVALID must be flashed');
  assert.strictEqual(store.locals['api_return_json'], '{}', name + ': api_return_json must be the empty object');
  assert.strictEqual(store.locals['par1'], '', name + ': no cache command may be staged (par1)');
  assert.strictEqual(store.locals['par2'], '', name + ': no cache command may be staged (par2)');
  assert.strictEqual(store.locals['api_duration_secs'], '', name + ': api_duration_secs must be cleared');
  assert.strictEqual(store.locals['api_distance_miles'], '', name + ': api_distance_miles must be cleared');
  assert.strictEqual(store.locals['api_transit_steps'], '', name + ': api_transit_steps must be cleared');
}

const cases = [
  ['duration-zero', route('0s', 1000)],
  ['duration-negative', route('-5s', 1000)],
  ['duration-missing', route(undefined, 1000)],
  ['duration-nonnumeric', route('abc', 1000)],
  ['distance-zero', route('600s', 0)],
  ['distance-negative', route('600s', -1)],
  ['distance-missing', route('600s', undefined)],
  ['distance-nonnumeric', route('600s', 'xyz')],
  ['distance-oversized', route('600s', 6000000)]
];
cases.forEach(function (c) {
  try { assertRejected(c[0], c[1]); } catch (e) { fail(c[0] + ': ' + e.message); }
});

// Valid positive metrics: the accepted path still stages the cache command.
try {
  const store = run(route('600s', 1000));
  if (store.runError) fail('valid control: parser threw: ' + store.runError.message);
  assert(!hasCode(store, 'API_METRICS_INVALID'), 'valid control must not flash API_METRICS_INVALID');
  const parsed = JSON.parse(store.locals['api_return_json']);
  assert.strictEqual(parsed.durationSecs, 600, 'valid control must publish durationSecs 600');
  assert.strictEqual(parsed.distanceMeters, 1000, 'valid control must publish distanceMeters 1000');
  assert.strictEqual(store.locals['par1'], 'SESSION_CACHE_UPSERT', 'valid control must stage SESSION_CACHE_UPSERT');
  const staged = JSON.parse(store.locals['par2']);
  assert.strictEqual(staged.durationSecs, 600, 'staged cache payload must carry the duration');
} catch (e) { fail('valid control: ' + e.message); }

// API_PARSER_FAULT (outer catch): local metric clears on the second path.
try {
  const store = run({}, { locals: { api_route_mode: 'CLUSTER', api_cluster_json: '{bad' } });
  if (store.runError) fail('fault case: parser threw: ' + store.runError.message);
  assert(hasCode(store, 'API_PARSER_FAULT'), 'fault case must flash API_PARSER_FAULT');
  assert.strictEqual(store.locals['api_return_json'], '{}', 'fault case: api_return_json must be the empty object');
  assert.strictEqual(store.locals['par1'], '', 'fault case: no cache command may be staged');
  assert.strictEqual(store.locals['api_duration_secs'], '', 'fault case: api_duration_secs must be cleared');
  assert.strictEqual(store.locals['api_distance_miles'], '', 'fault case: api_distance_miles must be cleared');
  assert.strictEqual(store.locals['api_transit_steps'], '', 'fault case: api_transit_steps must be cleared');
} catch (e) { fail('fault case: ' + e.message); }

try {
  const payloadPath = DATA + 'temp_payload.json';
  const original = JSON.stringify({ correlation: { generationId: GEN, clusterId: CLUSTER_ID, requestId: REQUEST_ID }, response: route('600s', 1000) });
  const unreadable = run(route('600s', 1000), { files: { [payloadPath]: original }, failures: { readThrows: ['TDS_Route_Request_State.json'] } });
  assert.strictEqual(unreadable.files[payloadPath], original, 'unreadable request state must preserve payload');
  assert(!unreadable.locals.par1, 'unreadable state must not stage a cache command');
  assert(unreadable.files[DATA + 'TDS_Route_Request_State.json'].indexOf(REQUEST_ID) !== -1, 'unreadable request state must remain available for retry');
  assert(hasCode(unreadable, 'REQUEST_STATE_UNREADABLE'), 'unreadable state must be logged');
  const missing = run(route('600s', 1000), { omitRequestState: true, files: { [payloadPath]: original } });
  assert(hasCode(missing, 'STALE_API_RESPONSE_DISCARDED'), 'missing state must remain stale');
  assert.strictEqual(missing.files[payloadPath], '{}', 'missing state must clear payload');
} catch (e) { fail('request-state unreadable/missing: ' + e.message); }

try {
  const cluster = { origin: '51.9,-2.1', waypoints: [{ id: 'wp1' }, { id: 'wp2' }], destination: { id: 'dest1' } };
  const clusterId = '51.9,-2.1|dest1|wp1,wp2';
  const files = {};
  files[DATA + 'TDS_Route_Request_State.json'] = JSON.stringify({ schemaVersion: 1, latestByCluster: { [clusterId]: { requestId: REQUEST_ID, generationId: GEN } } });
  files[DATA + 'temp_payload.json'] = JSON.stringify({ correlation: { generationId: GEN, clusterId: clusterId, requestId: REQUEST_ID }, response: { routes: [{ optimizedIntermediateWaypointIndex: [] }] } });
  const { sandbox, store } = createSandbox({ locals: { api_route_mode: 'CLUSTER', api_cluster_json: JSON.stringify(cluster) }, globals: { TDS_Active_Generation: GEN }, files: files, nowMs: nowSec * 1000 });
  runScript(PARSER, sandbox, store);
  assert.strictEqual(sandbox.local('par1'), '', 'empty index must not stage an order-cache command');
  assert.strictEqual(sandbox.local('par2'), '', 'empty index must not stage an order-cache payload');
  assert(logs(store).some(function (entry) { return entry.code === 'CLUSTER_ORDER_UNOPTIMIZED' && entry.severity === 'warn'; }), 'empty index must log CLUSTER_ORDER_UNOPTIMIZED');
} catch (e) { fail('empty optimized waypoint index: ' + e.message); }

if (failures > 0) { console.log('FAIL: api-parser — ' + failures + ' scenario(s) failed'); process.exit(1); }
console.log('PASS: api-parser — metrics rejection clears derived locals, stages empty json and no cache command; valid control stages it');
process.exit(0);
