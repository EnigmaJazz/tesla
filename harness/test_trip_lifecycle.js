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

// ============================================================
// Phase 6 slice 1 (PR 1): status observations (REQ-6STATE-3),
// projection (REQ-6STATE-2, SCN-6STATE-3/4), and the five
// R-TRIP-8 globals written post-commit by project().
// ============================================================

function testObserveBaseLeaveClearsAndProjects() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: GEN_ID, at: nowSec });
  const r = runCmd(sandbox, store, 'OBSERVE_BASE_LEAVE', { generationId: GEN_ID, at: nowSec + 120 });
  assert.strictEqual(r, 'OK', 'OBSERVE_BASE_LEAVE must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.userAtBase, false, 'base leave must clear userAtBase');
  assert.strictEqual(state.baseArrivalUnix, null, 'base leave must clear baseArrivalUnix');
  assert.strictEqual(store.globals['User_At_Base'], 'false', 'projection must write User_At_Base=false');
  assert.strictEqual(store.globals['Base_Arrival_Unix'], '', 'projection must write Base_Arrival_Unix as empty (null)');
  assert.strictEqual(state.revision, 2, 'revision must increment for observe + leave');
}

function testObserveBaseLeaveIdempotent() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: GEN_ID, at: nowSec });
  runCmd(sandbox, store, 'OBSERVE_BASE_LEAVE', { generationId: GEN_ID, at: nowSec + 120 });
  const r2 = runCmd(sandbox, store, 'OBSERVE_BASE_LEAVE', { generationId: GEN_ID, at: nowSec + 240 });
  assert.strictEqual(r2, 'OK', 'repeat OBSERVE_BASE_LEAVE must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.revision, 2, 'repeat base leave must be a no-op (revision unchanged)');
  assert.strictEqual(state.userAtBase, false, 'base leave stays clear');
}

function testObserveLatenessHaltCoercesAndProjects() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'OBSERVE_LATENESS_HALT', { generationId: GEN_ID, halt: true, at: nowSec });
  assert.strictEqual(r, 'OK', 'OBSERVE_LATENESS_HALT must be accepted');
  let state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.latenessHalt, true, 'halt:true must coerce to true');
  assert.strictEqual(store.globals['TDS_Lateness_Halt'], 'true', 'projection must write TDS_Lateness_Halt=true');
  // string "true" coerces identically and is a no-op against the same value
  runCmd(sandbox, store, 'OBSERVE_LATENESS_HALT', { generationId: GEN_ID, halt: 'true', at: nowSec + 60 });
  state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.latenessHalt, true, "halt:'true' must coerce to true");
  assert.strictEqual(state.revision, 1, "halt:'true' with the same value must be a no-op (revision unchanged)");
  // false clears and re-projects
  runCmd(sandbox, store, 'OBSERVE_LATENESS_HALT', { generationId: GEN_ID, halt: false, at: nowSec + 120 });
  state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.latenessHalt, false, 'halt:false must clear');
  assert.strictEqual(store.globals['TDS_Lateness_Halt'], 'false', 'projection must write TDS_Lateness_Halt=false');
  assert.strictEqual(state.revision, 2, 'clear must bump revision');
}

function testObserveStatusSetsAndProjects() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'OBSERVE_STATUS', { generationId: GEN_ID, status: 'Driving (Pitstop)', at: nowSec });
  assert.strictEqual(r, 'OK', 'OBSERVE_STATUS must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.currentStatus, 'Driving (Pitstop)', 'currentStatus must be set');
  assert.strictEqual(store.globals['Current_Status'], 'Driving (Pitstop)', 'projection must write Current_Status');
  assert.strictEqual(state.revision, 1, 'revision must increment');
}

function testObserveStatusIdempotent() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_STATUS', { generationId: GEN_ID, status: 'Idle', at: nowSec });
  const r2 = runCmd(sandbox, store, 'OBSERVE_STATUS', { generationId: GEN_ID, status: 'Idle', at: nowSec + 60 });
  assert.strictEqual(r2, 'OK', 'repeat OBSERVE_STATUS must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.revision, 1, 'same status must be a no-op (revision unchanged)');
}

function testObserveStatusRejectsInvalid() {
  const { sandbox, store } = make();
  const r = runCmd(sandbox, store, 'OBSERVE_STATUS', { generationId: GEN_ID, at: nowSec });
  assert.match(r, /^ERROR:/, 'missing status must be rejected');
  const logs = parseLog(store);
  const rejection = logs.find(function (l) { return l.code === 'GENERATION_VALIDATION_FAILED'; });
  assert(rejection, 'invalid payload must log GENERATION_VALIDATION_FAILED');
  assert(!store.files[STATE] || !JSON.parse(store.files[STATE]).currentStatus, 'invalid payload must not write status');
}

function testProjectionWritesFiveGlobalsPostCommit() {
  const { sandbox, store } = make();
  runCmd(sandbox, store, 'OBSERVE_LIVE_BASE', { generationId: GEN_ID, at: nowSec });
  assert.strictEqual(store.globals['User_At_Base'], 'true', 'User_At_Base must project committed state');
  assert.strictEqual(store.globals['Base_Arrival_Unix'], String(nowSec), 'Base_Arrival_Unix must project committed state');
  assert.strictEqual(store.globals['TDS_Lateness_Halt'], 'false', 'TDS_Lateness_Halt must project initial false');
  assert.strictEqual(store.globals['Current_Status'], '', 'Current_Status must project initial empty');
  assert.strictEqual(store.globals['TDS_Manual_Return_Completed'], 'false', 'TDS_Manual_Return_Completed must project initial false');
}

function testProjectionSkippedOnCommitFailure() {
  const { sandbox, store } = createSandbox({
    nowMs: nowSec * 1000,
    globals: {
      User_At_Base: 'true', Base_Arrival_Unix: String(nowSec),
      TDS_Lateness_Halt: 'false', Current_Status: 'At Home', TDS_Manual_Return_Completed: 'true'
    },
    failures: { tornWrites: [STATE] }
  });
  const r = runCmd(sandbox, store, 'OBSERVE_STATUS', { generationId: GEN_ID, status: 'Driving', at: nowSec });
  assert.match(r, /^ERROR:/, 'torn state write must fail the commit');
  const logs = parseLog(store);
  const skipped = logs.find(function (l) { return l.code === 'STATE_PROJECTION_SKIPPED'; });
  assert(skipped, 'commit failure must log STATE_PROJECTION_SKIPPED');
  assert.strictEqual(skipped.severity, 'warn', 'STATE_PROJECTION_SKIPPED must be warn severity');
  assert.strictEqual(skipped.details.command, 'OBSERVE_STATUS', 'STATE_PROJECTION_SKIPPED must name the command');
  assert.strictEqual(store.globals['User_At_Base'], 'true', 'prior global bytes must be preserved when projection is skipped');
  assert.strictEqual(store.globals['Current_Status'], 'At Home', 'prior Current_Status bytes must be preserved');
  assert.strictEqual(store.globals['TDS_Manual_Return_Completed'], 'true', 'prior manual-return bytes must be preserved');
}

try {
  testObserveArrivalMintsTrip();
  testObserveArrivalIsIdempotent();
  testObserveArrivalRejectsInvalid();
  testObserveLiveBaseSetsOrigin();
  testObserveLiveBaseIdempotentNoSpuriousLog();
  testObserveLiveBaseRejectsInvalid();
  testObserveBaseLeaveClearsAndProjects();
  testObserveBaseLeaveIdempotent();
  testObserveLatenessHaltCoercesAndProjects();
  testObserveStatusSetsAndProjects();
  testObserveStatusIdempotent();
  testObserveStatusRejectsInvalid();
  testProjectionWritesFiveGlobalsPostCommit();
  testProjectionSkippedOnCommitFailure();
  console.log('PASS: trip-lifecycle: arrival, live-base origin, idempotency, atomicity, status observations, projection');
} catch (e) {
  fail(e.message);
}
