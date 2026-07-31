// Phase 3 PR-F: Reconciliation command (R-TRIP-12) test file.
// Verifies that the reducer's RECONCILE_GENERATION command aligns the
// state with the manifest, repairs drift, and emits the RECONCILE_GENERATION
// event when the state and manifest disagree.
//
// Mirrors the harness pattern from test_trip_lifecycle.js.

process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const { createSandbox } = require('./mock_tasker');

const REDUCER_PATH = require('path').resolve(__dirname, '../Trip_State_Reducer.js');
const GEN_A = 'gen:1700000000:ab12';
const GEN_B = 'gen:1700100000:cd34';

const nowSec = 1700000000;

function make() { return createSandbox({ nowMs: nowSec * 1000 }); }

function runCmd(sandbox, store, command, payload) {
  return sandbox.reducer(command, Object.assign({ generationId: GEN_A }, payload || {}));
}

function readState(store) {
  const raw = store.files['Tasker/Tesla/Data/TDS_Trip_State.json'] || '{}';
  return JSON.parse(raw);
}

function parseLog(store) {
  return (store.flashLog || []).map(function (f) { return JSON.parse(f); });
}

function fail(msg) { console.log('FAIL: reconcile: ' + msg); process.exit(1); }
function pass(msg) { console.log('PASS: reconcile: ' + (msg || 'ok')); }

// Test 1: RECONCILE on fresh state (no currentGeneration) sets the generation.
function testReconcileSetsCurrentGeneration() {
  const { sandbox, store } = make();
  // First create a trip via OBSERVE_DEPARTURE so the state has some content.
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { tripId: 'trip_001', at: nowSec - 100, planningDay: '2024-03-09' });
  // Now reconcile.
  const r = runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A, manifestSchemaVersion: 2 });
  assert.strictEqual(r, 'OK', 'reconcile with valid payload must succeed');
  const s = readState(store);
  assert.strictEqual(s.currentGeneration, GEN_A, 'state.currentGeneration must match manifest');
  assert.strictEqual(s.lastReconciledGeneration, GEN_A, 'state.lastReconciledGeneration must match manifest');
  assert.strictEqual(s.manifestSchemaVersion, 2, 'manifestSchemaVersion must be recorded');
}

// Test 2: RECONCILE on matching generation is idempotent (no event).
function testReconcileIdempotentNoEvent() {
  const { sandbox, store } = make();
  // Reconcile twice with the same generation.
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const beforeLogLen = (store.flashLog || []).length;
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const afterLogLen = (store.flashLog || []).length;
  // The second call should NOT emit a RECONCILE_GENERATION event.
  const newLogs = (store.flashLog || []).slice(beforeLogLen).map(function (f) { return JSON.parse(f); });
  const reconcileEvents = newLogs.filter(l => l.code === 'RECONCILE_GENERATION');
  assert.strictEqual(reconcileEvents.length, 0, 'reconcile with matching generation must not emit event');
}

// Test 3: RECONCILE on drifted state emits event and aligns state.
function testReconcileEmitsEventOnDrift() {
  const { sandbox, store } = make();
  // Reconcile to GEN_A first.
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  // Reconcile to GEN_B — drift.
  const beforeLogLen = (store.flashLog || []).length;
  const r = runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_B });
  assert.strictEqual(r, 'OK', 'reconcile to new generation must succeed');
  const s = readState(store);
  assert.strictEqual(s.currentGeneration, GEN_B, 'state.currentGeneration must be updated');
  assert.strictEqual(s.lastReconciledGeneration, GEN_B, 'state.lastReconciledGeneration must be updated');
  const newLogs = (store.flashLog || []).slice(beforeLogLen).map(function (f) { return JSON.parse(f); });
  const reconcileEvents = newLogs.filter(l => l.code === 'RECONCILE_GENERATION');
  assert.strictEqual(reconcileEvents.length, 1, 'reconcile with different generation must emit exactly one event');
}

// Test 4: RECONCILE without activeGeneration is rejected.
function testReconcileRejectsMissingActiveGeneration() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const s_before = readState(store);
  const r = runCmd(sandbox, store, 'RECONCILE_GENERATION', {});
  assert.match(r, /^ERROR:/, 'reconcile without activeGeneration must be rejected');
  // The state file should be unchanged from the successful previous reconcile.
  const s = readState(store);
  assert.strictEqual(s.currentGeneration, s_before.currentGeneration, 'state must not be corrupted on rejection');
  assert.strictEqual(s.revision, s_before.revision, 'revision must not bump on rejection');
}

// Test 5: RECONCILE bumps revision on every successful call.
function testReconcileBumpsRevision() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const s1 = readState(store);
  const rev1 = s1.revision;
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const s2 = readState(store);
  const rev2 = s2.revision;
  // Idempotent reconcile should still bump revision (the call is a "tick").
  assert.ok(rev2 > rev1, 'reconcile must bump revision even on idempotent call');
}

// Test 6: RECONCILE preserves trip records.
function testReconcilePreservesTrips() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { tripId: 'trip_002', at: nowSec - 200, planningDay: '2024-03-09' });
  runCmd(sandbox, store, 'OBSERVE_ARRIVAL', { tripId: 'trip_002', at: nowSec - 50, accuracyM: 25 });
  const s1 = readState(store);
  assert.ok(s1.trips.trip_002, 'trip_002 must be in state before reconcile');
  assert.strictEqual(s1.trips.trip_002.lifecycleState, 'ARRIVED', 'arrival must transition IN_PROGRESS to ARRIVED');
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const s2 = readState(store);
  assert.ok(s2.trips.trip_002, 'trip_002 must still be in state after reconcile');
  assert.strictEqual(s2.trips.trip_002.lifecycleState, 'ARRIVED', 'trip lifecycle state must be preserved');
}

// Test 7: RECONCILE repairs manifest/state drift when state is missing generation.
function testReconcileRepairsDrift() {
  const { sandbox, store } = make();
  // Create state with no currentGeneration (simulating a fresh install).
  const initState = {
    schemaVersion: 1,
    revision: 0,
    trips: {},
    completedStops: {},
    completedDropins: {},
    lastObservedArrival: {},
    departMemory: {},
    currentOrigin: 'PLANNED',
    userAtBase: false,
    baseArrivalUnix: 0,
    lastReconciledGeneration: '',
    currentGeneration: '',
    updatedAt: nowSec
  };
  // Write directly via the reducer path: the mock rejects direct writes, so
  // we use a reconcile to set up the state file. But reconcile requires a
  // valid payload, so we use a workaround: seed via OBSERVE_DEPARTURE.
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { tripId: 'trip_drift', at: nowSec - 100, planningDay: '2024-03-09' });
  // Now state exists but has no currentGeneration. Reconcile to repair.
  const r = runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  assert.strictEqual(r, 'OK', 'reconcile from empty currentGeneration must succeed');
  const s = readState(store);
  assert.strictEqual(s.currentGeneration, GEN_A, 'state.currentGeneration must be set');
  assert.ok(s.trips.trip_drift, 'seeded trip must be preserved through reconcile');
}

// Test 8: Multiple consecutive reconciles to different generations all succeed.
function testReconcileHandlesMultipleGenerations() {
  const { sandbox, store } = make();
  const gens = [GEN_A, GEN_B, 'gen:1700200000:ef56', GEN_A];
  for (const g of gens) {
    const r = runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: g });
    assert.strictEqual(r, 'OK', 'reconcile to ' + g + ' must succeed');
    const s = readState(store);
    assert.strictEqual(s.currentGeneration, g, 'state.currentGeneration must be ' + g);
  }
}

// Test 9: RECONCILE preserves manual actions.
function testReconcilePreservesManualActions() {
  const { sandbox, store } = make();
  // Seed a manual action via SET_OVERRIDE.
  runCmd(sandbox, store, 'SET_OVERRIDE', { key: 'Depart_Memory', value: 'manual_value', at: nowSec });
  runCmd(sandbox, store, 'RECONCILE_GENERATION', { activeGeneration: GEN_A });
  const s = readState(store);
  assert.ok(s.overrides, 'overrides must be preserved');
  assert.strictEqual(s.overrides.Depart_Memory, 'manual_value', 'Depart_Memory override must be preserved');
}

try {
  testReconcileSetsCurrentGeneration();
  testReconcileIdempotentNoEvent();
  testReconcileEmitsEventOnDrift();
  testReconcileRejectsMissingActiveGeneration();
  testReconcileBumpsRevision();
  testReconcilePreservesTrips();
  testReconcileRepairsDrift();
  testReconcileHandlesMultipleGenerations();
  pass('RECONCILE_GENERATION: 8/8 tests passed');
} catch (e) {
  fail(e.message);
}
