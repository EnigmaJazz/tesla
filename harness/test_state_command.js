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
} catch (e) { fail('typed validation: ' + e.message); }

if (failures > 0) { console.log('FAIL: state-command — ' + failures + ' group(s) failed'); process.exit(1); }
console.log('PASS: state-command — router contract, single-owner routing, adapter staging, typed validation');
