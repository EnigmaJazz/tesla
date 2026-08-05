// Phase 4 Slice A RED — reorder ownership, pre-build admission, drain-clear.
// REQ-4REORDER-1 (SCN-4REORDER-1..2), REQ-4REORDER-2 (SCN-4REORDER-3).
// Fails on master: producers write the queue directly; the publisher matches
// the minted id, not the pre-build committed generation.

process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const QUEUE_FILE = DATA + 'TDS_Reorder_Commands.json';
const MANIFEST_FILE = DATA + 'TDS_Run_Manifest.json';
const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');
const GATEKEEPER = path.resolve(__dirname, '..', 'Gatekeeper.js');
const PUBLISHER = path.resolve(__dirname, '..', 'Generation_Publisher.js');
const PREBUILD_GEN = 'gen:1699999999:0001'; // committed generation active when producers emit
const PREBUILD_ENC = PREBUILD_GEN.replace(/:/g, '_');
const MINTED_GEN = 'gen:1700000000:ab12';   // the generation publish() will mint (forced)
const STALE_GEN = 'gen:1800000000:ffff';    // neither committed nor minted

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: reorder-queue — ' + msg); }
function make(opts) { return createSandbox(Object.assign({ nowMs: nowSec * 1000 }, opts || {})); }
function runRouter(sandbox, store) {
  sandbox.__currentScriptPath = STATE_COMMAND;
  runScript(STATE_COMMAND, sandbox, store);
  sandbox.__currentScriptPath = '';
}
function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function reorderCmd(overrides) {
  return Object.assign({ type: 'APPLY_CLUSTER_REORDER', generationId: null, clusterId: 'c1', orderedEventIds: ['e3', 'e1', 'e2'], source: 'test', emittedAt: nowSec }, overrides || {});
}
function manifest() {
  return { schemaVersion: 1, generationId: PREBUILD_GEN, activeGeneration: PREBUILD_GEN, previousGeneration: null,
    publishedAt: nowSec - 1, writer: 'Generation Publisher',
    eventsPath: DATA + 'TDS_Events.' + PREBUILD_ENC + '.json', masterPath: DATA + 'TDS_Master.' + PREBUILD_ENC + '.json',
    itineraryPath: DATA + 'Itin_Master.' + PREBUILD_ENC + '.json', eventCount: 1, legCount: 1, itineraryCount: 1,
    generationHistory: [PREBUILD_GEN], state: 'committed' };
}
function runPublish(queue) {
  const { sandbox, store } = make({ files: { [MANIFEST_FILE]: JSON.stringify(manifest()), [QUEUE_FILE]: JSON.stringify(queue || []) } });
  sandbox.Math.random = function () { return 0xab12 / 0x10000; }; // mint MINTED_GEN deterministically
  sandbox.__currentScriptPath = PUBLISHER;
  sandbox.setLocal('par1', JSON.stringify({ events: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }], master: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }], itinerary: [] }));
  runScript(PUBLISHER, sandbox, store);
  sandbox.__currentScriptPath = '';
  if (store.runError) throw new Error(store.runError.message);
  const m = JSON.parse(store.files[MANIFEST_FILE]);
  return { sandbox: sandbox, store: store, master: JSON.parse(store.files[m.masterPath]) };
}

// SCN-4REORDER-1: producer stages ENQUEUE_REORDER; the router appends; no published writes.
try {
  const cluster = { waypoints: [{ id: 'wp1', dropinOrder: 2 }, { id: 'wp2', dropinOrder: 1 }], destination: { id: 'dest1', coords: '52.0,-2.0' } };
  const { sandbox, store } = make({ locals: { par1: JSON.stringify(cluster), par11: '', par12: '', par13: '', par14: '' },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: PREBUILD_GEN }, files: { [QUEUE_FILE]: '[]' } });
  runScript(GATEKEEPER, sandbox, store);
  assert(store.runError === undefined, 'Gatekeeper must not crash');
  assert.strictEqual(sandbox.local('par1'), 'ENQUEUE_REORDER', 'Gatekeeper must stage ENQUEUE_REORDER');
  const staged = JSON.parse(sandbox.local('par2'));
  assert.deepStrictEqual(staged.orderedEventIds, ['wp2', 'wp1'], 'producer must stage the exact ordered IDs');
  assert.strictEqual(staged.generationId, PREBUILD_GEN, 'producer must stamp the generation active at emission');
  assert(!store.writeLog.some(function (w) { return w.path === QUEUE_FILE; }), 'producer must not write the queue directly');
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'router must enqueue');
  const queue = JSON.parse(store.files[QUEUE_FILE] || '[]');
  assert.strictEqual(queue.length, 1, 'router must append exactly one command');
  assert.strictEqual(queue[0].type, 'APPLY_CLUSTER_REORDER', 'enqueued command must keep the publisher type');
  assert.strictEqual(queue[0].generationId, PREBUILD_GEN, 'enqueued command must keep the stamped generation');
  assert(!store.writeLog.some(function (w) { return w.path.indexOf('Itin_Master.') !== -1 || w.path.indexOf('TDS_Master.') !== -1; }), 'enqueue must cause no published writes');
  assert(logs(store).some(function (l) { return l.code === 'REORDER_COMMAND_ENQUEUED'; }), 'enqueue must log REORDER_COMMAND_ENQUEUED');
} catch (e) { fail('producer staging + router enqueue: ' + e.message); }

// SCN-4REORDER-3: admission matrix — only pre-build and legacy-null commands apply.
try {
  const current = runPublish([reorderCmd({ generationId: PREBUILD_GEN })]);
  assert.deepStrictEqual(current.master.map(function (x) { return x.id; }), ['e3', 'e1', 'e2'], 'pre-build current command must apply');
  assert(!logs(current.store).some(function (l) { return l.code === 'STALE_REORDER_COMMAND_REJECTED'; }), 'current command must not be logged stale');
  const stale = runPublish([reorderCmd({ generationId: STALE_GEN })]);
  assert.deepStrictEqual(stale.master.map(function (x) { return x.id; }), ['e1', 'e2', 'e3'], 'stale command must not apply');
  assert(logs(stale.store).some(function (l) { return l.code === 'STALE_REORDER_COMMAND_REJECTED'; }), 'stale command must log STALE_REORDER_COMMAND_REJECTED');
  const minted = runPublish([reorderCmd({ generationId: MINTED_GEN })]);
  assert.deepStrictEqual(minted.master.map(function (x) { return x.id; }), ['e1', 'e2', 'e3'], 'minted-id command must not apply (pre-build matching, never minted)');
  assert(logs(minted.store).some(function (l) { return l.code === 'STALE_REORDER_COMMAND_REJECTED'; }), 'minted-id command must log STALE_REORDER_COMMAND_REJECTED');
  const malformed = runPublish([{ type: 'BOGUS_TYPE', generationId: PREBUILD_GEN, orderedEventIds: ['e3', 'e1', 'e2'] }]);
  assert.deepStrictEqual(malformed.master.map(function (x) { return x.id; }), ['e1', 'e2', 'e3'], 'malformed command must not apply');
  assert(logs(malformed.store).some(function (l) { return l.code === 'REORDER_COMMAND_REJECTED'; }), 'malformed command must log REORDER_COMMAND_REJECTED');
  const legacyNull = runPublish([reorderCmd({ generationId: null, source: 'Gatekeeper' })]);
  assert.deepStrictEqual(legacyNull.master.map(function (x) { return x.id; }), ['e3', 'e1', 'e2'], 'permitted legacy-null command must apply');
  const untrustedNull = runPublish([reorderCmd({ generationId: null, source: 'test' })]);
  assert.deepStrictEqual(untrustedNull.master.map(function (x) { return x.id; }), ['e1', 'e2', 'e3'], 'untrusted legacy-null command must NOT apply');
  assert(logs(untrustedNull.store).some(function (l) { return l.code === 'REORDER_COMMAND_REJECTED'; }), 'untrusted legacy-null must log REORDER_COMMAND_REJECTED');
} catch (e) { fail('admission matrix: ' + e.message); }

// SCN-4REORDER-2: every publish drains and clears the queue — nothing retained.
try {
  const mixed = runPublish([reorderCmd({ generationId: PREBUILD_GEN }), reorderCmd({ generationId: STALE_GEN }), { type: 'BOGUS', generationId: null }]);
  assert.strictEqual(mixed.store.files[QUEUE_FILE], '[]', 'queue must be empty after publish (no remaining)');
  assert(logs(mixed.store).some(function (l) { return l.code === 'REORDER_QUEUE_DRAINED'; }), 'publish must log REORDER_QUEUE_DRAINED');
} catch (e) { fail('drain-clear: ' + e.message); }

if (failures > 0) { console.log('FAIL: reorder-queue — ' + failures + ' group(s) failed'); process.exit(1); }
console.log('PASS: reorder-queue — staging ownership, pre-build admission matrix, drain-clear');
