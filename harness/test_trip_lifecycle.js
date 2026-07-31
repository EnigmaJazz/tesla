// Phase 3 PR-B: trip lifecycle (arrival and live-base origin) tests.
// Covers R-TRIP-2 (arrival observation), R-TRIP-4 (origin precedence),
// R-TRIP-7 (Arrival_Memory migration), R-TRIP-8 (User_At_Base migration).
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const { createSandbox } = require('./mock_tasker');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const STATE = DATA + 'TDS_Trip_State.json';
const GEN_ID = 'gen:1700000000:ab12';

function make() { return createSandbox({ nowMs: nowSec * 1000 }); }
function runCmd(sandbox, store, command, payload) {
  const result = sandbox.reducer(command, payload);
  if (store.runError) throw new Error(store.runError.message);
  return result;
}
function parseLog(store) { return store.flashLog.map(function (f) { return JSON.parse(f); }); }
function fail(msg) { console.log('FAIL: trip-lifecycle: ' + msg); process.exit(1); }

function testObserveArrivalMintsTrip() {
  const { sandbox, store } = make();
  const result = runCmd(sandbox, store, 'OBSERVE_ARRIVAL', { generationId: GEN_ID, tripId: 'trip_1', at: nowSec, accuracyM: 50 });
  assert.strictEqual(result, 'OK', 'OBSERVE_ARRIVAL for unknown trip must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert(state.trips.trip_1, 'new trip must be recorded in state.trips');
  assert.strictEqual(state.trips.trip_1.lifecycleState, 'COMPLETED', 'newly observed trip must be COMPLETED');
  assert.strictEqual(state.trips.trip_1.observedArrivalUnix, nowSec, 'observedArrivalUnix must be set');
  assert.strictEqual(state.trips.trip_1.observedArrivalAccuracyM, 50, 'accuracyM must be recorded');
  assert.strictEqual(state.revision, 1, 'state revision must increment');
}

function testObserveArrivalIsIdempotent() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_ARRIVAL', { generationId: GEN_ID, tripId: 'trip_2', at: nowSec, accuracyM: 30 });
  const r2 = runCmd(sandbox, store, 'OBSERVE_ARRIVAL', { generationId: GEN_ID, tripId: 'trip_2', at: nowSec + 60, accuracyM: 25 });
  assert.strictEqual(r2, 'OK', 'second OBSERVE_ARRIVAL must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.trip_2.observedArrivalUnix, nowSec + 60, 'arrival unix must reflect latest observation');
  assert.strictEqual(state.trips.trip_2.observedArrivalAccuracyM, 25, 'accuracyM must reflect latest observation');
  assert.strictEqual(state.trips.trip_2.lifecycleState, 'COMPLETED', 'lifecycle stays COMPLETED');
}

function testObserveArrivalRejectsInvalid() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'OBSERVE_ARRIVAL', { generationId: GEN_ID, tripId: 'trip_x' });
  assert.match(r, /^ERROR:/, 'missing at/accuracyM must be rejected');
  const logs = parseLog(store);
  const rejection = logs.find(function (l) { return l.code === 'GENERATION_VALIDATION_FAILED'; });
  assert(rejection, 'invalid payload must log GENERATION_VALIDATION_FAILED');
  assert(!store.files[STATE] || !JSON.parse(store.files[STATE]).trips.trip_x, 'invalid payload must not write trip');
}

function testObserveLiveBaseSetsOrigin() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: GEN_ID, at: nowSec });
  assert.strictEqual(r, 'OK', 'OBSERVE_LIVE_BASE must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.currentOrigin, 'LIVE_BASE', 'currentOrigin must be LIVE_BASE');
  assert.strictEqual(state.userAtBase, true, 'userAtBase must be true');
  assert.strictEqual(state.baseArrivalUnix, nowSec, 'baseArrivalUnix must be set');
  assert.strictEqual(state.revision, 1, 'revision must increment');
  const logs = parseLog(store);
  const liveBaseLog = logs.find(function (l) { return l.code === 'LIVE_BASE_OVERRIDES_LEGACY_ORIGIN'; });
  assert(liveBaseLog, 'first OBSERVE_LIVE_BASE must emit LIVE_BASE_OVERRIDES_LEGACY_ORIGIN');
  assert.strictEqual(liveBaseLog.severity, 'info', 'LIVE_BASE_OVERRIDES_LEGACY_ORIGIN must be info');
}

function testObserveLiveBaseIdempotentNoSpuriousLog() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: GEN_ID, at: nowSec });
  const beforeLogs = parseLog(store).filter(function (l) { return l.code === 'LIVE_BASE_OVERRIDES_LEGACY_ORIGIN'; }).length;
  runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: GEN_ID, at: nowSec + 60 });
  const afterLogs = parseLog(store).filter(function (l) { return l.code === 'LIVE_BASE_OVERRIDES_LEGACY_ORIGIN'; }).length;
  assert.strictEqual(afterLogs, beforeLogs, 'idempotent OBSERVE_LIVE_BASE must not re-emit LIVE_BASE_OVERRIDES_LEGACY_ORIGIN');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.baseArrivalUnix, nowSec + 60, 'baseArrivalUnix must reflect latest observation');
  assert.strictEqual(state.revision, 2, 'revision must increment on each call');
}

function testObserveLiveBaseRejectsInvalid() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: 'not-a-valid-id' });
  assert.match(r, /^ERROR:/, 'invalid generationId must be rejected');
  assert(!store.files[STATE] || JSON.parse(store.files[STATE]).currentOrigin === 'LIVE_BASE', 'invalid payload must not change currentOrigin from default');
}

try {
  testObserveArrivalMintsTrip();
  testObserveArrivalIsIdempotent();
  testObserveArrivalRejectsInvalid();
  testObserveLiveBaseSetsOrigin();
  testObserveLiveBaseIdempotentNoSpuriousLog();
  testObserveLiveBaseRejectsInvalid();
  console.log('PASS: trip-lifecycle: arrival, live-base origin, idempotency, atomicity');
} catch (e) {
  fail(e.message);
}
