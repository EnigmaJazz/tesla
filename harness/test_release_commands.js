// Phase 4 Slice C RED — helper restriction, ownership guards, owner rows.
// REQ-4HELPER-1 (SCN-4HELPER-1), REQ-4LOG-1 (SCN-4LOG-1), plus the lock
// ownership-guard row (REQ-4ADAPTER-6/7). COMPLETE_STOP staging, exact
// RELEASE and Finaliser completion flows live in test_ac5.js (Slice C block).
//
// Fails on Slice B (current master): TDS_Helper still answers bare
// events|master|itinerary reads and the legacy Filename:Index:Key getter,
// and no HELPER_REQUEST_REJECTED log exists.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const SESSIONS = DATA + 'TDS_Action_Sessions.json';
const MANUAL_TRIPS = DATA + 'TDS_Manual_Trips.json';
const LOCK = DATA + 'TDS_Action_Lock.json';
const GEN_ID = 'gen:1700000000:ab12';
const B36 = nowSec.toString(36);
const ACTION_ID = 'action_' + B36;
const TRIP_ID = 'manual_return_' + B36;

const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');
const TDS_HELPER = path.resolve(__dirname, '..', 'TDS_Helper.js');

const failures = [];
function section(name, fn) {
  try { fn(); console.log('  ok: ' + name); }
  catch (e) { failures.push(name + ' :: ' + e.message); console.log('  FAIL: ' + name + ' :: ' + e.message); }
}
function make(files) {
  return createSandbox({ files: files || {}, nowMs: nowSec * 1000 });
}
function runRouter(sandbox, store, command, payload) {
  sandbox.__currentScriptPath = STATE_COMMAND;
  sandbox.setLocal('par1', command);
  sandbox.setLocal('par2', JSON.stringify(payload));
  runScript(STATE_COMMAND, sandbox, store);
  sandbox.__currentScriptPath = '';
  if (store.runError) throw new Error(store.runError.message);
  return sandbox.local('return_value');
}
function runHelper(par1, files) {
  // Fresh sandbox per invocation: TDS_Helper declares top-level consts that
  // cannot be re-declared in a shared vm context.
  const { sandbox, store } = make(files);
  sandbox.setLocal('par1', par1);
  sandbox.setLocal('par2', '');
  runScript(TDS_HELPER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  return { rv: sandbox.local('return_value'), store: store };
}
function parseLog(store) {
  return (store.flashLog || []).map(function (f) {
    try { return JSON.parse(f); } catch (e) { return null; }
  }).filter(Boolean);
}
function logFieldsOk(l) {
  return typeof l.timestamp === 'number' && 'generationId' in l && typeof l.component === 'string'
    && l.component.length > 0 && typeof l.severity === 'string' && typeof l.code === 'string'
    && 'tripId' in l && typeof l.details === 'object';
}

section('helper-rejects-unknown-and-legacy', function () {
  const files = { [DATA + 'TDS_Master.json']: JSON.stringify([{ id: 'legacy_1' }]) };
  const r1 = runHelper('master', files);
  assert(r1.rv.indexOf('ERROR:') === 0, 'bare kind read must be rejected, got: ' + r1.rv);
  assert(parseLog(r1.store).some(function (l) { return l.code === 'HELPER_REQUEST_REJECTED' && logFieldsOk(l); }),
    'rejection must log HELPER_REQUEST_REJECTED with LOG-17 fields');
  const r2 = runHelper('TDS_Master:0:id', files);
  assert(r2.rv.indexOf('ERROR:') === 0, 'legacy Filename:Index:Key getter must be rejected, got: ' + r2.rv);
  const r3 = runHelper('readOrigin:bogus', files);
  assert(r3.rv.indexOf('ERROR:') === 0, 'readOrigin with a suffix must be rejected, got: ' + r3.rv);
  assert(parseLog(r3.store).some(function (l) { return l.code === 'HELPER_REQUEST_REJECTED' && logFieldsOk(l); }),
    'readOrigin:bogus must log HELPER_REQUEST_REJECTED with LOG-17 fields');
  const r4 = runHelper('readActiveGeneration:bogus', files);
  assert(r4.rv.indexOf('ERROR:') === 0, 'readActiveGeneration with an unknown kind must be rejected, got: ' + r4.rv);
  assert(parseLog(r4.store).some(function (l) { return l.code === 'HELPER_REQUEST_REJECTED' && logFieldsOk(l); }),
    'readActiveGeneration:bogus must log HELPER_REQUEST_REJECTED with LOG-17 fields');
  const r5 = runHelper('readActiveGeneration:master', files);
  assert(r5.rv.indexOf('ERROR:') !== 0, 'readActiveGeneration:master must be accepted, got: ' + r5.rv);
});

section('owner-row-on-handler-clear', function () {
  const sessions = { schemaVersion: 1, sessions: { [ACTION_ID]: { actionId: ACTION_ID, tripId: TRIP_ID, status: 'ACTIVE', closedAt: null, closeReason: null } } };
  const trips = { schemaVersion: 1, trips: { [TRIP_ID]: { tripId: TRIP_ID, actionId: ACTION_ID, lifecycleState: 'IN_PROGRESS' } } };
  const matchingLock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 10000, eventId: TRIP_ID });
  const { sandbox, store } = make({ [SESSIONS]: JSON.stringify(sessions), [MANUAL_TRIPS]: JSON.stringify(trips), [LOCK]: matchingLock });
  const r = runRouter(sandbox, store, 'RELEASE', { actionId: ACTION_ID, tripId: TRIP_ID, at: nowSec });
  assert(r.indexOf('OK') === 0, 'RELEASE must be accepted: ' + r);
  const lockWrite = store.writeLog.find(function (w) { return w.path === LOCK; });
  assert(lockWrite && lockWrite.owner, 'lock write must record an owner row');
  assert(lockWrite.owner.indexOf('TDS_State_Command.js') !== -1, 'lock owner must be State Command, got: ' + lockWrite.owner);
  assert.strictEqual(store.files[LOCK], '{}', 'RELEASE must clear the matching legacy lock');
  const logs = parseLog(store);
  assert(logs.some(function (l) { return l.code === 'LOCK_COMPATIBILITY_CLEARED' && logFieldsOk(l); }), 'LOCK_COMPATIBILITY_CLEARED must carry LOG-17 fields');
  assert(logs.some(function (l) { return l.code === 'SESSION_CLOSED' && logFieldsOk(l); }), 'SESSION_CLOSED must carry LOG-17 fields');
});

try {
  console.log('Phase 4 Slice C release-command regression suite:');
  if (failures.length > 0) {
    console.log('FAILED SECTIONS: ' + failures.length);
    process.exit(1);
  }
  console.log('PASS: release commands — helper restriction, owner guards, owner rows');
  process.exit(0);
} catch (e) {
  console.log('FAIL: ' + e.message);
  process.exit(1);
}
