// Phase 3 PR-A: Trip State Reducer shell and command contract.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const STATE = DATA + 'TDS_Trip_State.json';
const REDUCER = path.resolve(__dirname, '..', 'Trip_State_Reducer.js');
const GEN_ID = 'gen:1700000000:ab12';

function make() {
  return createSandbox({ nowMs: nowSec * 1000 });
}
function runReducer(sandbox, store, command, payload, context) {
  const result = sandbox.reducer(command, payload, context);
  if (store.runError) throw new Error(store.runError.message);
  return result;
}
function parseLog(store) {
  return store.flashLog.map(function (f) { return JSON.parse(f); });
}
function fail(msg) { console.log('FAIL: reducer-commands: ' + msg); process.exit(1); }

function testUnauthorizedWriter() {
  const { sandbox, store } = make();
  assert.throws(
    function () { sandbox.writeFile(STATE, 'corrupt'); },
    /UNAUTHORIZED_WRITE_REJECTED/,
    'direct write to TDS_Trip_State.json must be rejected'
  );
  assert(!store.files[STATE], 'unauthorized write must not persist state');
}

function testInvalidCommandName() {
  const { sandbox, store } = make();
  const result = runReducer(sandbox, store, 'BOGUS', { generationId: GEN_ID });
  assert.match(result, /^ERROR:/, 'invalid command name must return error');
  const logs = parseLog(store);
  const rejection = logs.find(function (l) { return l.code === 'GENERATION_VALIDATION_FAILED'; });
  assert(rejection, 'invalid command name must log EVT-GENERATION_VALIDATION_FAILED');
  assert.strictEqual(rejection.details.command, 'BOGUS');
  assert(!store.files[STATE], 'invalid command must not write state');
}

function testInvalidPayload() {
  const { sandbox, store } = make();
  const result = runReducer(sandbox, store, 'DEPART_NOW', { generationId: GEN_ID });
  assert.match(result, /^ERROR:/, 'missing payload fields must return error');
  const logs = parseLog(store);
  const rejection = logs.find(function (l) { return l.code === 'GENERATION_VALIDATION_FAILED'; });
  assert(rejection, 'invalid payload must log EVT-GENERATION_VALIDATION_FAILED');
  assert(rejection.details.reason.indexOf('tripId') !== -1 || rejection.details.reason.indexOf('at') !== -1, 'reason must name missing field');
}

function testSchemaVersioning() {
  const { sandbox, store } = make();
  const result = runReducer(sandbox, store, 'SET_OVERRIDE', { generationId: GEN_ID, key: 'work_coords', value: '52.1,-2.2' });
  assert.strictEqual(result, 'OK', 'valid command must be accepted');
  const raw = store.files[STATE];
  assert(raw, 'valid command must write state file');
  const state = JSON.parse(raw);
  assert.strictEqual(state.schemaVersion, 1, 'state must be schemaVersion 1');
  assert.strictEqual(state.revision, 0, 'initial state must have revision 0');
  assert.deepStrictEqual(state.trips, {}, 'trips map must be empty');
  assert.deepStrictEqual(state.stops, {}, 'stops map must be empty');
  assert.deepStrictEqual(state.manualSessions, {}, 'manualSessions map must be empty');
}

function testAtomicity() {
  const { sandbox, store } = make();
  runReducer(sandbox, store, 'SET_OVERRIDE', { generationId: GEN_ID, key: 'k', value: 'v' });
  assert(store.files[STATE], 'state file must be written before projection');
  assert.strictEqual(Object.keys(store.globals).length, 0, 'PR-A must not project any global');
}

function testObservability() {
  const { sandbox, store } = make();
  runReducer(sandbox, store, 'BOGUS', { generationId: GEN_ID });
  const logs = parseLog(store);
  assert(logs.length > 0, 'rejection must be logged');
  const log = logs[0];
  assert(typeof log.timestamp === 'number', 'log must have timestamp');
  assert(log.component === 'Trip State Reducer', 'log must identify component');
  assert(log.severity === 'error', 'invalid command log must be error severity');
  assert(log.code, 'log must have code');
  assert(Object.prototype.hasOwnProperty.call(log, 'tripId'), 'log must have tripId');
  assert(log.details && typeof log.details === 'object', 'log must have details object');
}

function testDirectRunScriptGuarded() {
  // Running the reducer directly via runScript without the shim should not be
  // able to write state because the mock does not know the caller is the reducer.
  const { sandbox, store } = make();
  sandbox.setLocal('par1', 'SET_OVERRIDE');
  sandbox.setLocal('par2', JSON.stringify({ generationId: GEN_ID, key: 'k', value: 'v' }));
  runScript(REDUCER, sandbox, store);
  assert(!store.files[STATE], 'direct runScript must not persist state');
  const rv = sandbox.local('return_value');
  assert(rv.indexOf('ERROR:') === 0, 'direct runScript must return error');
  assert(rv.indexOf('UNAUTHORIZED_WRITE_REJECTED') !== -1 || rv.indexOf('READ_BACK_MISMATCH') !== -1, 'error must report write rejection');
}

function testConcurrencySameTick() {
  const { sandbox, store } = make();
  const r1 = runReducer(sandbox, store, 'SET_OVERRIDE', { generationId: GEN_ID, key: 'k1', value: 'v1' });
  const r2 = runReducer(sandbox, store, 'SET_OVERRIDE', { generationId: GEN_ID, key: 'k2', value: 'v2' });
  assert.strictEqual(r1, 'OK');
  assert.strictEqual(r2, 'OK');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.revision, 0, 'stub commands must not increment revision');
}

// Slice B (AC-5): COMPLETE_TRIP validation contract. The command must accept
// an optional planningDay label alongside tripId/at, reject a payload missing
// required fields, and never write state on rejection.
function testCompleteTripRejectsMissingFields() {
  const { sandbox, store } = make();
  const r1 = runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, at: nowSec });
  assert.match(r1, /^ERROR:/, 'COMPLETE_TRIP missing tripId must return error');
  const r2 = runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 'trip_x' });
  assert.match(r2, /^ERROR:/, 'COMPLETE_TRIP missing at must return error');
  const logs = parseLog(store);
  const rejections = logs.filter(function (l) { return l.code === 'GENERATION_VALIDATION_FAILED'; });
  assert.strictEqual(rejections.length, 2, 'each invalid payload must log GENERATION_VALIDATION_FAILED');
  assert(!store.files[STATE], 'rejected COMPLETE_TRIP must not write state');
}

function testCompleteTripAcceptsPlanningDay() {
  // planningDay is optional but must be accepted when present.
  const { sandbox, store } = make();
  runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 'trip_y', at: nowSec, planningDay: '2023-11-14' });
  const logs = parseLog(store);
  const accepted = logs.find(function (l) { return l.code === 'TRIP_STATE_COMMAND_ACCEPTED'; });
  assert(accepted, 'COMPLETE_TRIP with planningDay must be accepted');
}

try {
  testUnauthorizedWriter();
  testInvalidCommandName();
  testInvalidPayload();
  testSchemaVersioning();
  testAtomicity();
  testObservability();
  testDirectRunScriptGuarded();
  testConcurrencySameTick();
  testCompleteTripRejectsMissingFields();
  testCompleteTripAcceptsPlanningDay();
  console.log('PASS: reducer-commands: reducer shell, contract, and atomicity');
} catch (e) {
  fail(e.message);
}
