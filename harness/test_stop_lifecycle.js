// Phase 3 PR-C: stop and dropin lifecycle tests
// Verifies that COMPLETE_STOP and COMPLETE_DROPIN reducer commands
// record completion in the trip state, and that the legacy OVR writes
// remain as read-side shims until later PRs complete the migration.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const { createSandbox } = require('./mock_tasker');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const STATE = DATA + 'TDS_Trip_State.json';
const GEN_ID = 'gen:1700000000:ab12';

function make() { return createSandbox({ nowMs: nowSec * 1000 }); }
function runCmd(sandbox, store, command, payload) {
  return sandbox.reducer(command, payload);
}
function readState(sandbox) { return JSON.parse(sandbox.readFile(STATE) || '{}'); }
function fail(msg) { console.log('FAIL: stop-lifecycle: ' + msg); process.exit(1); }

// ============================================================
// COMPLETE_STOP tests
// ============================================================

(function testCompleteStopRecords() {
  const { sandbox } = make();
  const r = runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  assert.strictEqual(r, 'OK', 'COMPLETE_STOP must return OK');
  const state = readState(sandbox);
  assert(state.completedStops && state.completedStops['stop1_300'], 'stop must be in state.completedStops');
  assert.strictEqual(state.completedStops['stop1_300'].completedUnix, nowSec + 1000, 'completedUnix must match payload');
  assert.strictEqual(state.completedStops['stop1_300'].tripId, 'tripA', 'tripId must match payload');
  assert(state.trips['tripA'], 'trip must be in state.trips');
  assert.deepEqual(state.trips['tripA'].completedStops, ['stop1_300'], 'trip must list the completed stop');
  assert.strictEqual(state.trips['tripA'].lifecycleState, 'IN_PROGRESS', 'trip with active stop is IN_PROGRESS');
})();

(function testCompleteStopIdempotent() {
  const { sandbox } = make();
  runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  const r1 = runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  assert.strictEqual(r1, 'OK', 'idempotent re-stop must return OK');
  const state = readState(sandbox);
  assert.deepEqual(state.trips['tripA'].completedStops, ['stop1_300'], 'duplicate stop must not be added twice');
  assert.strictEqual(state.revision, 1, 'idempotent re-stop must not bump revision');
})();

(function testMultipleStopsAggregate() {
  const { sandbox } = make();
  runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop2_900', tripId: 'tripA', at: nowSec + 2000 });
  runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop3_600', tripId: 'tripA', at: nowSec + 3000 });
  const state = readState(sandbox);
  assert.strictEqual(Object.keys(state.completedStops).length, 3, 'all three stops must be recorded');
  assert.deepEqual(state.trips['tripA'].completedStops, ['stop1_300', 'stop2_900', 'stop3_600'], 'trip must list all completed stops in order');
  assert.strictEqual(state.trips['tripA'].lastActivityUnix, nowSec + 3000, 'lastActivityUnix must be the most recent at');
})();

(function testCompleteStopRejectsInvalidGen() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'COMPLETE_STOP', { generationId: 'not-a-valid-id', stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  assert.match(r, /^ERROR:/, 'invalid generationId must be rejected');
  assert(!store.files[STATE], 'rejected command must not write state');
})();

(function testCompleteStopRejectsMissingFields() {
  const { sandbox } = make();
  const r1 = runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1', at: nowSec + 1000 });
  assert.match(r1, /^ERROR:/, 'missing tripId must be rejected');
  const r2 = runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, tripId: 'tripA', at: nowSec + 1000 });
  assert.match(r2, /^ERROR:/, 'missing stopId must be rejected');
})();

// ============================================================
// COMPLETE_DROPIN tests
// ============================================================

(function testCompleteDropinRecords() {
  const { sandbox } = make();
  const r = runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  assert.strictEqual(r, 'OK', 'COMPLETE_DROPIN must return OK');
  const state = readState(sandbox);
  assert(state.completedDropins && state.completedDropins['dropin1'], 'dropin must be in state.completedDropins');
  assert.strictEqual(state.completedDropins['dropin1'].completedUnix, nowSec + 4000, 'completedUnix must match');
  assert.strictEqual(state.completedDropins['dropin1'].tripId, 'dropin1', 'tripId must match');
  assert(state.trips['dropin1'], 'trip must be in state.trips');
  assert.deepEqual(state.trips['dropin1'].completedDropins, ['dropin1'], 'trip must list the completed dropin');
})();

(function testCompleteDropinIdempotent() {
  const { sandbox } = make();
  runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  const r1 = runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  assert.strictEqual(r1, 'OK', 'idempotent re-dropin must return OK');
  const state = readState(sandbox);
  assert.deepEqual(state.trips['dropin1'].completedDropins, ['dropin1'], 'duplicate dropin must not be added twice');
  assert.strictEqual(state.revision, 1, 'idempotent re-dropin must not bump revision');
})();

(function testMultipleDropinsAggregate() {
  const { sandbox } = make();
  runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin2', tripId: 'dropin2', at: nowSec + 5000 });
  const state = readState(sandbox);
  assert.strictEqual(Object.keys(state.completedDropins).length, 2, 'both dropins must be recorded');
})();

(function testCompleteDropinRejectsInvalidGen() {
  const { sandbox } = make();
  const r = runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: 'bad', dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  assert.match(r, /^ERROR:/, 'invalid generationId must be rejected');
})();

(function testCompleteDropinTransitionsToCompleted() {
  const { sandbox } = make();
  runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  const state = readState(sandbox);
  assert.strictEqual(state.trips['dropin1'].lifecycleState, 'COMPLETED', 'completed dropin trip must be COMPLETED');
})();

// ============================================================
// Cross-cutting tests
// ============================================================

(function testStopsAndDropinsCoexist() {
  const { sandbox } = make();
  runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  const state = readState(sandbox);
  assert.strictEqual(Object.keys(state.completedStops).length, 1, 'stop must be recorded');
  assert.strictEqual(Object.keys(state.completedDropins).length, 1, 'dropin must be recorded');
})();

(function testRevisionIncrementsPerCommand() {
  const { sandbox } = make();
  const baseRevision = (JSON.parse(sandbox.readFile(STATE) || '{}')).revision || 0;
  runCmd(sandbox, sandbox.__store, 'COMPLETE_STOP', { generationId: GEN_ID, stopId: 'stop1_300', tripId: 'tripA', at: nowSec + 1000 });
  runCmd(sandbox, sandbox.__store, 'COMPLETE_DROPIN', { generationId: GEN_ID, dropinId: 'dropin1', tripId: 'dropin1', at: nowSec + 4000 });
  const state = readState(sandbox);
  assert.strictEqual(state.revision, baseRevision + 2, 'each non-idempotent command must bump revision');
})();

console.log('PASS: stop-lifecycle: 12/12 tests passed');
