// Phase 4 Slice A RED — TDS_State_Command serial router contract.
// REQ-4CMD-1 (SCN-4CMD-1..2), REQ-4ADAPTER-1..2 (SCN-4ADAPTER-1..2).
// Fails on master: no TDS_State_Command.js; producers write state directly.

process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');
const APPENDER = path.resolve(__dirname, '..', 'Appender.js');
const INJECTOR = path.resolve(__dirname, '..', 'Override_Injector.js');
const OVR_FILE = DATA + 'TDS_Overrides.json';
const STATE_FILE = DATA + 'TDS_Trip_State.json';
const ACTIVE_GEN = 'gen:1700000000:ab12';
const GEN_ENC = ACTIVE_GEN.replace(/:/g, '_');
const ID_RECENT = 'abc123_s44tm8'; // base-36 suffix in the valid ID-2 range

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: state-command — ' + msg); }
function make(opts) { return createSandbox(Object.assign({ nowMs: nowSec * 1000 }, opts || {})); }
function runRouter(sandbox, store) {
  sandbox.__currentScriptPath = STATE_COMMAND;
  runScript(STATE_COMMAND, sandbox, store);
  sandbox.__currentScriptPath = '';
}
function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function logFieldsOk(l) {
  return typeof l.timestamp === 'number' && 'generationId' in l && typeof l.component === 'string' && l.component.length > 0
    && typeof l.severity === 'string' && typeof l.code === 'string' && 'tripId' in l && typeof l.details === 'object';
}
function manifest(activeGen) {
  return { schemaVersion: 1, generationId: activeGen, activeGeneration: activeGen, previousGeneration: null,
    publishedAt: nowSec, writer: 'Generation Publisher',
    eventsPath: DATA + 'TDS_Events.' + GEN_ENC + '.json', masterPath: DATA + 'TDS_Master.' + GEN_ENC + '.json',
    itineraryPath: DATA + 'Itin_Master.' + GEN_ENC + '.json', eventCount: 1, legCount: 1, itineraryCount: 1,
    generationHistory: [activeGen], state: 'committed' };
}
// SCN-4CMD-2: malformed/unknown/field-invalid envelopes are rejected before any mutation.
function rejectCase(name, par1, par2) {
  try {
    const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
    sandbox.setLocal('par1', par1); sandbox.setLocal('par2', par2);
    runRouter(sandbox, store);
    assert(store.runError === undefined, name + ' must not crash');
    assert.strictEqual(sandbox.local('return_value').slice(0, 5), 'ERROR', name + ' must return ERROR');
    assert.strictEqual(sandbox.local('tds_state_owner'), '', name + ' must not set an owner');
    assert.strictEqual(store.writeLog.length, 0, name + ' must not write any file');
    const rej = logs(store).filter(function (l) { return l.code === 'STATE_COMMAND_REJECTED'; });
    assert(rej.length >= 1 && logFieldsOk(rej[0]), name + ' must log STATE_COMMAND_REJECTED with all LOG-17 fields');
  } catch (e) { fail(name + ': ' + e.message); }
}
rejectCase('malformed JSON', 'APPLY_OVERRIDE', '{not json');
rejectCase('unknown command', 'NOT_A_COMMAND', '{}');
rejectCase('field-type error', 'ENQUEUE_REORDER', JSON.stringify({ clusterId: 'c1', orderedEventIds: 'nope', source: 'test' }));

// SCN-4CMD-1: exactly one owner receives APPLY_OVERRIDE.
try {
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', 'APPLY_OVERRIDE');
  sandbox.setLocal('par2', JSON.stringify({ targetId: ID_RECENT, overrideKey: 'Forced_Drives' }));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'valid override must not crash');
  assert.strictEqual(sandbox.local('tds_state_owner'), 'Override_Handler', 'APPLY_OVERRIDE must route to exactly one owner');
  assert.strictEqual(JSON.parse(sandbox.local('return_value')).ok, true, 'owner result must pass through return_value');
  assert(store.writeLog.filter(function (w) { return w.path === OVR_FILE; }).length >= 1, 'the Override Handler must apply the command');
  assert(!store.writeLog.some(function (w) { return w.path === STATE_FILE || w.path.indexOf('TDS_Run_Manifest') !== -1; }), 'no other owner may run');
  const routed = logs(store).filter(function (l) { return l.code === 'STATE_COMMAND_ROUTED'; });
  assert(routed.length === 1 && routed[0].generationId === ACTIVE_GEN && routed[0].details.owner === 'Override_Handler' && logFieldsOk(routed[0]),
    'must log STATE_COMMAND_ROUTED once, naming the owner, with all LOG-17 fields');
} catch (e) { fail('single-owner routing: ' + e.message); }

// SCN-4CMD-1: RECONCILE_GENERATION routes to the Trip State Reducer.
try {
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', 'RECONCILE_GENERATION');
  sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN, activeGeneration: ACTIVE_GEN, manifestSchemaVersion: 2 }));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'reconcile must not crash');
  assert.strictEqual(sandbox.local('tds_state_owner'), 'Trip_State_Reducer', 'RECONCILE_GENERATION must route to the reducer');
  assert.strictEqual(sandbox.local('return_value'), 'OK', 'reducer result must pass through');
  assert(store.writeLog.some(function (w) { return w.path === STATE_FILE; }), 'the reducer must commit its state file');
} catch (e) { fail('reducer routing: ' + e.message); }

// SCN-4CMD-1: PUBLISH_GENERATION routes to the Generation Publisher.
try {
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', 'PUBLISH_GENERATION');
  sandbox.setLocal('par2', JSON.stringify({ events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] }));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'publish must not crash');
  assert.strictEqual(sandbox.local('tds_state_owner'), 'Generation_Publisher', 'PUBLISH_GENERATION must route to the publisher');
  assert(/^gen:\d{10}:[0-9a-f]{4}$/.test(sandbox.local('return_value')), 'publish must return the minted generation id');
  assert(JSON.parse(store.files[DATA + 'TDS_Run_Manifest.json']).state === 'committed', 'publish through the router must commit a generation');
} catch (e) { fail('publisher routing: ' + e.message); }

// SCN-4ADAPTER-1: Appender stages exact-ID APPEND_OVERRIDE; the router delivers it.
// Adapter and router run in SEPARATE sandboxes: Tasker runs each JSlet in its
// own context, and the staged locals thread between them.
try {
  const stage = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  stage.sandbox.setLocal('final_return', 'LIFT|' + ID_RECENT + '|51.9,-2.1^51.5,-2.0');
  runScript(APPENDER, stage.sandbox, stage.store);
  assert(stage.store.runError === undefined, 'Appender must not crash');
  assert.strictEqual(stage.sandbox.local('par1'), 'APPEND_OVERRIDE', 'Appender must stage APPEND_OVERRIDE');
  assert.strictEqual(JSON.parse(stage.sandbox.local('par2')).baseId, ID_RECENT, 'Appender must stage the exact occurrence ID');
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', stage.sandbox.local('par1'));
  sandbox.setLocal('par2', stage.sandbox.local('par2'));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'router must accept the Appender envelope');
  assert.strictEqual(sandbox.local('tds_state_owner'), 'Override_Handler', 'Appender command must reach the Override Handler');
  assert(store.writeLog.some(function (w) { return w.path === OVR_FILE; }), 'the Override Handler must apply the append');
} catch (e) { fail('Appender staging: ' + e.message); }

// SCN-4ADAPTER-2: Override Injector stages exact-ID APPLY_OVERRIDE; the router delivers it.
try {
  const files = { [DATA + 'TDS_Run_Manifest.json']: JSON.stringify(manifest(ACTIVE_GEN)),
    [DATA + 'Itin_Master.' + GEN_ENC + '.json']: JSON.stringify([{ tripId: 'leg1', targetEventId: ID_RECENT, targetCoords: '51.5,-2.0' }]) };
  const stage = make({ globals: { TDS_Active_Generation: ACTIVE_GEN }, files: files });
  stage.sandbox.setLocal('par1', '0'); stage.sandbox.setLocal('par2', 'Forced_Drives');
  runScript(INJECTOR, stage.sandbox, stage.store);
  assert(stage.store.runError === undefined, 'Injector must not crash');
  assert.strictEqual(stage.sandbox.local('par1'), 'APPLY_OVERRIDE', 'Injector must stage APPLY_OVERRIDE');
  assert.strictEqual(JSON.parse(stage.sandbox.local('par2')).targetId, ID_RECENT, 'Injector must stage the exact occurrence ID');
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', stage.sandbox.local('par1'));
  sandbox.setLocal('par2', stage.sandbox.local('par2'));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'router must accept the Injector envelope');
  assert.strictEqual(sandbox.local('tds_state_owner'), 'Override_Handler', 'Injector command must reach the Override Handler');
  assert(store.writeLog.some(function (w) { return w.path === OVR_FILE; }), 'the Override Handler must apply the injector command');
} catch (e) { fail('Injector staging: ' + e.message); }

// REQ-4CMD-1 (SCN-4CMD-2): typed pre-invocation validation — an incomplete or
// wrong-typed reducer payload must be rejected BEFORE any owner runs.
try {
  const expire = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  expire.sandbox.setLocal('par1', 'EXPIRE_TRIP');
  expire.sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN }));
  runRouter(expire.sandbox, expire.store);
  assert.strictEqual(expire.sandbox.local('tds_state_owner'), '', 'EXPIRE_TRIP missing tripId must NOT set an owner');
  assert(/ERROR: missing tripId/.test(expire.sandbox.local('return_value')), 'missing tripId must be rejected');
  assert(!expire.store.writeLog.some(function (w) { return w.path === STATE_FILE; }), 'rejected EXPIRE_TRIP must not write state');

  const wrongType = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  wrongType.sandbox.setLocal('par1', 'COMPLETE_TRIP');
  wrongType.sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN, tripId: 123, at: 'now' }));
  runRouter(wrongType.sandbox, wrongType.store);
  assert.strictEqual(wrongType.sandbox.local('tds_state_owner'), '', 'wrong-typed COMPLETE_TRIP must NOT set an owner');
  assert(/ERROR: tripId must be string/.test(wrongType.sandbox.local('return_value')), 'wrong-typed tripId must be rejected');
  assert(!wrongType.store.writeLog.some(function (w) { return w.path === STATE_FILE; }), 'rejected COMPLETE_TRIP must not write state');

  const badGen = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  badGen.sandbox.setLocal('par1', 'COMPLETE_TRIP');
  badGen.sandbox.setLocal('par2', JSON.stringify({ generationId: 'not-a-gen', tripId: 't1', at: 100 }));
  runRouter(badGen.sandbox, badGen.store);
  assert(/ERROR: invalid generationId format/.test(badGen.sandbox.local('return_value')), 'malformed generationId must be rejected');

  // Parity with reducer COMMANDS: SET_OVERRIDE requires key+value (any).
  const setOvr = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  setOvr.sandbox.setLocal('par1', 'SET_OVERRIDE');
  setOvr.sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN }));
  runRouter(setOvr.sandbox, setOvr.store);
  assert(/ERROR: missing key/.test(setOvr.sandbox.local('return_value')), 'SET_OVERRIDE missing key must be rejected');
  assert.strictEqual(setOvr.sandbox.local('tds_state_owner'), '', 'rejected SET_OVERRIDE must not set an owner');

  // Parity: OBSERVE_LIVE_BASE at is OPTIONAL in the reducer — a payload
  // without at is reducer-valid and must route, never be over-rejected.
  const liveBase = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  liveBase.sandbox.setLocal('par1', 'OBSERVE_LIVE_BASE');
  liveBase.sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN }));
  runRouter(liveBase.sandbox, liveBase.store);
  assert.strictEqual(liveBase.sandbox.local('tds_state_owner'), 'Trip_State_Reducer', 'reducer-valid OBSERVE_LIVE_BASE without at must route');

  // Parity: optional typed field present with wrong type must be rejected.
  const wrongOptional = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  wrongOptional.sandbox.setLocal('par1', 'COMPLETE_TRIP');
  wrongOptional.sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN, tripId: 't1', at: 100, planningDay: 123 }));
  runRouter(wrongOptional.sandbox, wrongOptional.store);
  assert(/ERROR: planningDay must be string/.test(wrongOptional.sandbox.local('return_value')), 'wrong-typed optional planningDay must be rejected');

  // Parity: RECONCILE_GENERATION must go through the full reducer map — a
  // wrong-typed manifestSchemaVersion and a malformed generationId must be
  // rejected pre-owner (regression: a special-case branch used to shadow it).
  const reconcileType = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  reconcileType.sandbox.setLocal('par1', 'RECONCILE_GENERATION');
  reconcileType.sandbox.setLocal('par2', JSON.stringify({ generationId: ACTIVE_GEN, activeGeneration: ACTIVE_GEN, manifestSchemaVersion: 'two' }));
  runRouter(reconcileType.sandbox, reconcileType.store);
  assert(/ERROR: manifestSchemaVersion must be number/.test(reconcileType.sandbox.local('return_value')), 'wrong-typed manifestSchemaVersion must be rejected');
  assert.strictEqual(reconcileType.sandbox.local('tds_state_owner'), '', 'rejected RECONCILE_GENERATION must not set an owner');

  const reconcileGen = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  reconcileGen.sandbox.setLocal('par1', 'RECONCILE_GENERATION');
  reconcileGen.sandbox.setLocal('par2', JSON.stringify({ generationId: 'bad', activeGeneration: ACTIVE_GEN }));
  runRouter(reconcileGen.sandbox, reconcileGen.store);
  assert(/ERROR: invalid generationId format/.test(reconcileGen.sandbox.local('return_value')), 'malformed RECONCILE generationId must be rejected');
} catch (e) { fail('typed validation: ' + e.message); }

// ---------------------------------------------------------------------
// FU1 (REQ-6FU-3, SCN-6FU-6): a malformed REDUCER_BATCH envelope is rejected
// whole with BATCH_ENVELOPE_REJECTED — no owner, no file change.
// ---------------------------------------------------------------------
function batchRejectCase(name, par2) {
  try {
    const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
    sandbox.setLocal('par1', 'REDUCER_BATCH');
    sandbox.setLocal('par2', JSON.stringify(par2));
    runRouter(sandbox, store);
    assert(store.runError === undefined, name + ' must not crash');
    assert.strictEqual(sandbox.local('return_value').slice(0, 5), 'ERROR', name + ' must return ERROR');
    assert.strictEqual(sandbox.local('tds_state_owner'), '', name + ' must not set an owner');
    assert(!store.writeLog.some(function (w) { return w.path === STATE_FILE; }), name + ' must not write state');
    const rej = logs(store).filter(function (l) { return l.code === 'BATCH_ENVELOPE_REJECTED'; });
    assert(rej.length >= 1 && logFieldsOk(rej[0]), name + ' must log BATCH_ENVELOPE_REJECTED with all LOG-17 fields');
  } catch (e) { fail(name + ': ' + e.message); }
}
// MAX_REDUCER_BATCH_SIZE = 32 in TDS_State_Command.js; 33 entries is oversized.
batchRejectCase('batch missing commands', { generationId: ACTIVE_GEN });
batchRejectCase('batch non-array commands', { generationId: ACTIVE_GEN, commands: 'nope' });
batchRejectCase('batch empty commands', { generationId: ACTIVE_GEN, commands: [] });
batchRejectCase('batch non-object entry', { generationId: ACTIVE_GEN, commands: ['DEPART_NOW'] });
batchRejectCase('batch nested REDUCER_BATCH', { generationId: ACTIVE_GEN, commands: [{ command: 'REDUCER_BATCH', payload: { commands: [] } }] });
batchRejectCase('batch unknown sub-command', { generationId: ACTIVE_GEN, commands: [{ command: 'NOT_A_CMD', payload: {} }] });
batchRejectCase('batch bad generationId', { generationId: 'nope', commands: [{ command: 'OBSERVE_STATUS', payload: { generationId: ACTIVE_GEN, status: 'Idle', at: 100 } }] });
batchRejectCase('batch oversized', { generationId: ACTIVE_GEN, commands: Array(33).fill({ command: 'OBSERVE_LATENESS_HALT', payload: { generationId: ACTIVE_GEN, halt: false, at: 100 } }) });

// SCN-4CMD-3 / SCN-6FU-2: a valid REDUCER_BATCH routes to exactly the reducer
// (one owner entry) and every sub-command applies in order.
try {
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', 'REDUCER_BATCH');
  sandbox.setLocal('par2', JSON.stringify({
    generationId: ACTIVE_GEN,
    commands: [
      { command: 'OBSERVE_LIVE_BASE', payload: { generationId: ACTIVE_GEN, at: 100 } },
      { command: 'OBSERVE_STATUS', payload: { generationId: ACTIVE_GEN, status: 'Idle', at: 100 } },
      { command: 'OBSERVE_LATENESS_HALT', payload: { generationId: ACTIVE_GEN, halt: false, at: 100 } }
    ]
  }));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'valid batch must not crash');
  assert.strictEqual(sandbox.local('tds_state_owner'), 'Trip_State_Reducer', 'REDUCER_BATCH must route to exactly the reducer');
  assert.strictEqual(sandbox.local('return_value'), 'OK', 'valid batch must be accepted');
  const state = JSON.parse(store.files[STATE_FILE]);
  assert.strictEqual(state.userAtBase, true, 'OBSERVE_LIVE_BASE must apply');
  assert.strictEqual(state.currentStatus, 'Idle', 'OBSERVE_STATUS must apply');
  assert.strictEqual(state.latenessHalt, false, 'OBSERVE_LATENESS_HALT must apply');
  const routed = logs(store).filter(function (l) { return l.code === 'STATE_COMMAND_ROUTED'; });
  assert(routed.length === 1 && routed[0].details.owner === 'Trip_State_Reducer', 'batch must be routed once to the reducer');
  const delivered = logs(store).find(function (l) { return l.code === 'REDUCER_BATCH_DELIVERED'; });
  assert(delivered && delivered.details.applied === 3 && delivered.details.skipped === 0, 'delivery log must report all applied');
} catch (e) { fail('batch routing: ' + e.message); }

// REQ-6FU-2 (SCN-6FU-4): partial failure — a malformed COMPLETE_TRIP between
// valid sub-commands is logged-and-skipped without mutation; the valid
// sub-commands before and after still apply in order.
try {
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', 'REDUCER_BATCH');
  sandbox.setLocal('par2', JSON.stringify({
    generationId: ACTIVE_GEN,
    commands: [
      { command: 'OBSERVE_LIVE_BASE', payload: { generationId: ACTIVE_GEN, at: 100 } },
      { command: 'COMPLETE_TRIP', payload: { generationId: ACTIVE_GEN, tripId: 't1' } },
      { command: 'OBSERVE_STATUS', payload: { generationId: ACTIVE_GEN, status: 'At Home', at: 100 } }
    ]
  }));
  runRouter(sandbox, store);
  assert(store.runError === undefined, 'partial-failure batch must not crash');
  assert.strictEqual(sandbox.local('return_value'), 'OK', 'the envelope is well-formed; rejection is per sub-command');
  const state = JSON.parse(store.files[STATE_FILE]);
  assert.strictEqual(state.userAtBase, true, 'valid sub-command before the bad one must apply');
  assert.strictEqual(state.currentStatus, 'At Home', 'valid sub-command after the bad one must apply');
  assert(!state.trips.t1, 'the invalid COMPLETE_TRIP must not mutate state');
  const rej = logs(store).filter(function (l) { return l.code === 'BATCH_SUBCOMMAND_REJECTED'; });
  assert(rej.length === 1 && logFieldsOk(rej[0]) && rej[0].details.command === 'COMPLETE_TRIP' && rej[0].details.index === 1,
    'BATCH_SUBCOMMAND_REJECTED must be logged once naming the command and index');
  const delivered = logs(store).find(function (l) { return l.code === 'REDUCER_BATCH_DELIVERED'; });
  assert(delivered && delivered.details.applied === 2 && delivered.details.skipped === 1, 'delivery log must report applied/skipped');
} catch (e) { fail('batch partial-failure: ' + e.message); }

// REQ-6FU-3 (SCN-6FU-7): nested parity — a sub-command payload failing its
// REDUCER_REQUIRED_FIELDS entry is skipped with byte-identical rejection
// semantics to a direct invalid command; valid neighbours still apply.
try {
  const { sandbox, store } = make({ globals: { TDS_Active_Generation: ACTIVE_GEN } });
  sandbox.setLocal('par1', 'REDUCER_BATCH');
  sandbox.setLocal('par2', JSON.stringify({
    generationId: ACTIVE_GEN,
    commands: [
      { command: 'OBSERVE_STATUS', payload: { generationId: ACTIVE_GEN, at: 100 } },
      { command: 'OBSERVE_STATUS', payload: { generationId: ACTIVE_GEN, status: 'Driving', at: 100 } }
    ]
  }));
  runRouter(sandbox, store);
  const state = JSON.parse(store.files[STATE_FILE]);
  assert.strictEqual(state.currentStatus, 'Driving', 'the valid sub-command must apply');
  const rej = logs(store).filter(function (l) { return l.code === 'BATCH_SUBCOMMAND_REJECTED'; });
  assert(rej.length === 1 && rej[0].details.reason === 'missing status',
    'sub-command must be rejected byte-identical to a direct invalid command');
} catch (e) { fail('batch nested parity: ' + e.message); }

if (failures > 0) { console.log('FAIL: state-command — ' + failures + ' group(s) failed'); process.exit(1); }
console.log('PASS: state-command — router contract, single-owner routing, adapter staging, typed validation, batch envelope');
