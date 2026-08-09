// Cluster_Builder harness — dropin grouping into route-optimization clusters.
// Covers: consecutive-dropin grouping, next-main destination, BASE tail
// destination (raw_base_data field 2 / Home_Coords fallback), forced
// dropinOrder passthrough, multi-group index selection + eof, no-dropin days,
// unusable-coords waypoint skips (per-event + whole group), malformed input.

process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const BUILDER = path.resolve(__dirname, '..', 'Cluster_Builder.js');

const nowSec = 1700000000;
const homeCoords = '51.9,-2.1';
const aCoords = '51.92,-2.05';
const bCoords = '52.0,-2.0';
const d1Coords = '51.94,-2.02';
const d2Coords = '51.96,-2.04';

// raw_base_data: entries split by "|", fields by "~"; field index 2 = coords.
const baseGeocodes = [nowSec, nowSec + 86400, homeCoords, '0', 'Home', '', 'home_base'].join('~');

function ev(id, title, coords, extra) {
  return Object.assign({
    id: id, title: title, desc: '', start: nowSec + 3600, end: nowSec + 7200,
    loc: title, coords: coords
  }, extra || {});
}

const mainA = ev('main_a_kx8f00', 'Work', aCoords);
const mainB = ev('main_b_lx8g01', 'Gym', bCoords);
const dropin1 = ev('drop1_m5xg00', 'Shop', d1Coords, { isDropin: true, desc: '#dropin' });
const dropin2 = ev('drop2_n6yh11', 'Bank', d2Coords, { isDropin: true, desc: '#dropin' });

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: cluster-builder — ' + msg); }
function make(events, extraLocals, extraGlobals) {
  const locals = Object.assign({ tds_temp_json: JSON.stringify(events), raw_base_data: baseGeocodes }, extraLocals || {});
  const globals = Object.assign({ Home_Coords: homeCoords }, extraGlobals || {});
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: {}, nowMs: nowSec * 1000 });
  runScript(BUILDER, sandbox, store);
  return store;
}
function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function hasCode(store, code) {
  return logs(store).some(function (l) { return l.code === code; });
}
function parsedCluster(store) {
  const raw = store.locals['par1'];
  return raw ? JSON.parse(raw) : null;
}

// SCN-1: consecutive dropins between two main events -> one cluster, next-main destination.
try {
  const store = make([mainA, dropin1, dropin2, mainB]);
  if (store.runError) fail('mid-day fixture threw: ' + store.runError.message);
  assert.strictEqual(store.locals['cluster_count'], '1', 'count must be 1');
  assert.strictEqual(store.locals['cluster_eof'], 'false', 'idx 1 of 1 must not be eof');
  const c = parsedCluster(store);
  assert(c, 'par1 must be a cluster');
  assert.strictEqual(c.destination.id, 'main_b_lx8g01', 'destination must be the next main event');
  assert.strictEqual(c.destination.coords, bCoords, 'destination coords must come from the next main event');
  assert.strictEqual(c.waypoints.length, 2, 'both dropins must be waypoints');
  assert.strictEqual(c.waypoints[0].id, 'drop1_m5xg00', 'waypoint order preserved (1)');
  assert.strictEqual(c.waypoints[1].id, 'drop2_n6yh11', 'waypoint order preserved (2)');
  assert.strictEqual(c.waypoints[0].coords, d1Coords, 'waypoint coords carried');
  assert(hasCode(store, 'CLUSTER_BUILT'), 'CLUSTER_BUILT must be logged');
} catch (e) { fail('mid-day group: ' + e.message); }

// SCN-2: forced dropinOrder passes through in input order (Gatekeeper sorts later).
try {
  const forced1 = Object.assign({}, dropin1, { dropinOrder: 2 });
  const forced2 = Object.assign({}, dropin2, { dropinOrder: 1 });
  const store = make([mainA, forced1, forced2, mainB]);
  const c = parsedCluster(store);
  assert.strictEqual(c.waypoints[0].dropinOrder, 2, 'first waypoint carries its dropinOrder');
  assert.strictEqual(c.waypoints[1].dropinOrder, 1, 'second waypoint carries its dropinOrder');
  assert.strictEqual(c.waypoints[0].id, 'drop1_m5xg00', 'input order must not be sorted by the builder');
} catch (e) { fail('forced order: ' + e.message); }

// SCN-3: tail group after the last main event -> BASE destination from raw_base_data field 2.
try {
  const store = make([mainA, dropin1, dropin2]);
  const c = parsedCluster(store);
  assert.strictEqual(c.destination.id, 'BASE', 'tail destination id must be BASE');
  assert.strictEqual(c.destination.coords, homeCoords, 'tail destination coords from raw_base_data field 2');
  assert.strictEqual(c.waypoints.length, 2, 'tail dropins are waypoints');
} catch (e) { fail('tail group base: ' + e.message); }

// SCN-4: tail group with empty raw_base_data -> Home_Coords global fallback.
try {
  const store = make([mainA, dropin1], { raw_base_data: '' });
  const c = parsedCluster(store);
  assert.strictEqual(c.destination.id, 'BASE', 'fallback destination id must be BASE');
  assert.strictEqual(c.destination.coords, homeCoords, 'fallback coords must come from Home_Coords');
} catch (e) { fail('tail group home fallback: ' + e.message); }

// SCN-5: two separate groups; index selection and eof.
try {
  const store = make([dropin1, mainA, dropin2, mainB]);
  assert.strictEqual(store.locals['cluster_count'], '2', 'two groups must count 2');
  const c1 = parsedCluster(store);
  assert.strictEqual(c1.destination.id, 'main_a_kx8f00', 'first cluster destination is main A');

  const store2 = make([dropin1, mainA, dropin2, mainB], { cluster_idx: '2' });
  const c2 = parsedCluster(store2);
  assert.strictEqual(c2.destination.id, 'main_b_lx8g01', 'second cluster destination is main B');
  assert.strictEqual(store2.locals['cluster_eof'], 'false', 'idx 2 of 2 must not be eof');

  const store3 = make([dropin1, mainA, dropin2, mainB], { cluster_idx: '3' });
  assert.strictEqual(store3.locals['par1'], '', 'idx beyond count must stage empty par1');
  assert.strictEqual(store3.locals['cluster_eof'], 'true', 'idx beyond count must be eof');
} catch (e) { fail('multi-group selection: ' + e.message); }

// SCN-6: no dropins -> no clusters, eof.
try {
  const store = make([mainA, mainB]);
  assert.strictEqual(store.locals['cluster_count'], '0', 'no dropins -> count 0');
  assert.strictEqual(store.locals['cluster_eof'], 'true', 'no dropins -> eof');
  assert.strictEqual(store.locals['par1'], '', 'no dropins -> empty par1');
  assert(hasCode(store, 'NO_DROPIN_CLUSTERS'), 'NO_DROPIN_CLUSTERS must be logged');
} catch (e) { fail('no dropins: ' + e.message); }

// SCN-7a: group whose waypoints all have "0,0" coords -> group skipped, logged.
try {
  const badD1 = Object.assign({}, dropin1, { coords: '0,0' });
  const badD2 = Object.assign({}, dropin2, { coords: '0,0' });
  const store = make([mainA, badD1, badD2, mainB]);
  assert.strictEqual(store.locals['cluster_count'], '0', 'all-unusable group must not build a cluster');
  const skip = logs(store).filter(function (l) { return l.code === 'CLUSTER_SKIPPED'; });
  assert(skip.length >= 3, 'per-event skips + group skip must be logged, got ' + skip.length);
  assert(skip.every(function (l) { return l.details && l.details.reason === 'no_waypoint_coords'; }), 'skip reasons must be no_waypoint_coords');
  const ids = skip.map(function (l) { return l.details.eventId; }).filter(Boolean);
  assert(ids.indexOf('drop1_m5xg00') !== -1 && ids.indexOf('drop2_n6yh11') !== -1, 'per-event skip must name both dropins');
} catch (e) { fail('all-unusable waypoints: ' + e.message); }

// SCN-7b: one usable + one unusable -> cluster built with only the usable waypoint.
try {
  const badD1 = Object.assign({}, dropin1, { coords: '0,0' });
  const store = make([mainA, badD1, dropin2, mainB]);
  assert.strictEqual(store.locals['cluster_count'], '1', 'group with one usable waypoint must build');
  const c = parsedCluster(store);
  assert.strictEqual(c.waypoints.length, 1, 'only the usable waypoint remains');
  assert.strictEqual(c.waypoints[0].id, 'drop2_n6yh11', 'usable waypoint id');
  assert(hasCode(store, 'CLUSTER_SKIPPED'), 'per-event skip must be logged');
} catch (e) { fail('mixed usable waypoints: ' + e.message); }

// SCN-8: malformed %tds_temp_json -> fault, empty staging.
try {
  const store = make('{not json');
  assert(hasCode(store, 'CLUSTER_BUILDER_FAULT'), 'malformed input must log CLUSTER_BUILDER_FAULT');
  assert.strictEqual(store.locals['par1'], '', 'fault must stage empty par1');
  assert.strictEqual(store.locals['cluster_eof'], 'true', 'fault must stage eof');
  assert.strictEqual(store.locals['cluster_count'], '0', 'fault must stage count 0');
} catch (e) { fail('malformed input: ' + e.message); }

// SCN-9: missing %cluster_idx -> stages the first cluster.
try {
  const store = make([dropin1, mainA, dropin2, mainB]);
  const c = parsedCluster(store);
  assert(c && c.destination.id === 'main_a_kx8f00', 'missing idx must stage the first cluster');
} catch (e) { fail('missing cluster_idx: ' + e.message); }

if (failures > 0) { console.log('FAIL: cluster-builder — ' + failures + ' group(s) failed'); process.exit(1); }
console.log('PASS: cluster-builder — grouping, BASE tail, forced order, multi-group eof, waypoint skips, fault handling');
process.exit(0);
