// FU1 RED → GREEN (REQ-6FU-1, SCN-6FU-1A/2): production-faithful serial
// delivery of every observation staged in one Sandbox pass.
//
// The serial Tasker model delivers only the LAST staged par1/par2 per pass to
// TDS_State_Command. The Sandbox stages up to four reducer observations per
// pass (base arrival/leave, COMPLETE_TRIP, OBSERVE_STATUS, the always-run
// lateness-halt reset), so today every observation except the final halt is
// silently dropped on device; the harness's synchronous reducer() shim masks
// the loss. This test runs the Sandbox in serialMode (no shim — accumulate
// only), then ONE TDS_State_Command invocation, and proves every staged
// observation lands in trip state.
//
// RED baseline: pre-fix the staged par1 is the LAST observation
// (OBSERVE_LATENESS_HALT), not a REDUCER_BATCH envelope, so the first
// assertion fails with the last-wins value. GREEN: the batch envelope is
// staged and one router invocation delivers all sub-commands in order.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;                    // 2023-11-14T22:13:20Z
const todayDay = '2023-11-14';
const tomorrowDay = '2023-11-15';
const DATA = 'Tasker/Tesla/Data/';
const STATE = DATA + 'TDS_Trip_State.json';
const GEN_ID = 'gen:1700000000:ab12';
const homeCoords = '51.9,-2.1';
const awayCoords = '52.45,-2.1';

const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

const failures = [];
function section(name, fn) {
  try {
    fn();
    console.log('  ok: ' + name);
  } catch (e) {
    failures.push(name + ' :: ' + e.message);
    console.log('  FAIL: ' + name + ' :: ' + e.message);
  }
}

function seededState(trips, extra) {
  return JSON.stringify(Object.assign({
    schemaVersion: 1, revision: 0, generationId: GEN_ID,
    currentOrigin: 'PLANNED', currentPlanningDay: '', userAtBase: false,
    baseArrivalUnix: null, latenessHalt: false, currentStatus: '',
    manualReturnCompleted: false, trips: trips || {}, stops: {},
    manualSessions: {}
  }, extra || {}));
}

function make(files, globals, locals) {
  return createSandbox({
    serialMode: true,
    files: files || {},
    globals: globals || {},
    locals: locals || {},
    nowMs: nowSec * 1000
  });
}

function parseLog(store) {
  return (store.flashLog || []).map(function (f) {
    try { return JSON.parse(f); } catch (e) { return null; }
  }).filter(Boolean);
}

// Fixture shared with test_ac5's base-arrival pass: the user is at home with
// Current_Status "Updating"; the Sandbox detects the base arrival, completes
// the active manual return, observes status, and resets the lateness halt.
const baseGeocodes = [nowSec.toString(), (nowSec + 86400).toString(), homeCoords, '0', 'Home', '', 'home_base'].join('~');
const futureEvent = JSON.stringify([{
  id: 'ev_tomorrow_kx8f06',
  start: nowSec + 86400 + 3600,
  end: nowSec + 86400 + 7200,
  duration: 3600,
  title: 'Work',
  desc: '',
  loc: 'Office',
  coords: awayCoords
}]);
const commonFiles = {
  [DATA + 'Itin_Master.json']: '[]',
  [DATA + 'TDS_Base_Geocodes.txt']: baseGeocodes,
  [DATA + 'TDS_Overrides.json']: '{}',
  [DATA + 'Temp_Route_Cache.txt']: '',
  [DATA + 'RouteCache.txt']: ''
};
const arrivalGlobals = {
  User_At_Base: 'false', Base_Arrival_Unix: '0', User_Loc: homeCoords,
  Home_Coords: homeCoords, Current_Status: 'Updating', Arrival_Buffer_Mins: '5',
  Departure_Buffer_Mins: '5', Max_Walk_Meters: '8046', Daily_Walk_Meters: '0',
  Live_Traffic_Threshold: '7200', Car_Connected: 'false', TDS_Active_Generation: GEN_ID
};
const arrivalLocals = { idx: '1', virtual_loc: homeCoords, vcar_loc: homeCoords, virtual_time: String(nowSec) };
const seededTrips = {
  today_ret: { tripId: 'today_ret', lifecycleState: 'IN_PROGRESS', departures: [{ at: nowSec - 1800, planningDay: todayDay }], completedStops: [], completedDropins: [], lastActivityUnix: nowSec - 1800, currentPlanningDay: todayDay },
  tomorrow_trip: { tripId: 'tomorrow_trip', lifecycleState: 'PLANNED', departures: [], completedStops: [], completedDropins: [], lastActivityUnix: null, currentPlanningDay: tomorrowDay }
};

// SCN-6FU-1A/2: base-arrival pass — OBSERVE_LIVE_BASE, COMPLETE_TRIP,
// OBSERVE_STATUS, OBSERVE_LATENESS_HALT must ALL reach trip state through one
// serial TDS_State_Command invocation, in staging order.
section('serial-pass-stages-one-reducer-batch', function () {
  const files = Object.assign({}, commonFiles, {
    [DATA + 'TDS_Master.json']: futureEvent,
    [STATE]: seededState(seededTrips)
  });
  const { sandbox, store } = make(files, arrivalGlobals, arrivalLocals);
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  // No reducer shim in serialMode: the pass must not have written state.
  assert.strictEqual(store.files[STATE], seededState(seededTrips),
    'serial pass without a shim must not apply anything to state');

  // The pass must stage ONE REDUCER_BATCH envelope, not a last-wins command.
  assert.strictEqual(store.locals.par1, 'REDUCER_BATCH',
    'staged par1 must be REDUCER_BATCH (last-wins pre-fix: got ' + store.locals.par1 + ')');
  const envelope = JSON.parse(store.locals.par2);
  assert.strictEqual(envelope.generationId, GEN_ID, 'batch envelope must carry the active generation');
  assert(Array.isArray(envelope.commands), 'batch envelope must carry a commands array');
  assert.deepStrictEqual(envelope.commands.map(function (c) { return c.command; }),
    ['OBSERVE_LIVE_BASE', 'COMPLETE_TRIP', 'OBSERVE_STATUS', 'OBSERVE_LATENESS_HALT'],
    'batch must preserve staging order');
});

section('one-router-invocation-delivers-every-observation', function () {
  const files = Object.assign({}, commonFiles, {
    [DATA + 'TDS_Master.json']: futureEvent,
    [STATE]: seededState(seededTrips)
  });
  const { sandbox, store } = make(files, arrivalGlobals, arrivalLocals);
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  // ONE TDS_State_Command invocation via the router shim (serialMode runs the
  // staged owner after the router, exactly like the serial Tasker task).
  const rv = sandbox.stateCommand(store.locals.par1, JSON.parse(store.locals.par2));
  assert.strictEqual(rv, 'OK', 'REDUCER_BATCH must be accepted by the router: ' + rv);

  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.userAtBase, true, 'OBSERVE_LIVE_BASE must set userAtBase');
  assert.strictEqual(state.baseArrivalUnix, nowSec, 'OBSERVE_LIVE_BASE must record baseArrivalUnix');
  assert.strictEqual(state.trips.today_ret.lifecycleState, 'COMPLETED', 'COMPLETE_TRIP must complete the active manual return');
  assert.strictEqual(state.trips.today_ret.completedUnix, nowSec, 'COMPLETE_TRIP must record completedUnix');
  assert.strictEqual(state.currentStatus, 'At Home', 'OBSERVE_STATUS must set currentStatus');
  assert.strictEqual(state.latenessHalt, false, 'OBSERVE_LATENESS_HALT reset must keep halt false');
  assert.strictEqual(state.manualReturnCompleted, true, 'COMPLETE_TRIP must record manualReturnCompleted');
  assert.strictEqual(state.trips.tomorrow_trip.lifecycleState, 'PLANNED', 'tomorrow trip must stay PLANNED');

  // project() must have projected the five status globals from committed state.
  assert.strictEqual(store.globals['User_At_Base'], 'true', 'projection must publish User_At_Base');
  assert.strictEqual(store.globals['Base_Arrival_Unix'], String(nowSec), 'projection must publish Base_Arrival_Unix');
  assert.strictEqual(store.globals['Current_Status'], 'At Home', 'projection must publish Current_Status');
  assert.strictEqual(store.globals['TDS_Lateness_Halt'], 'false', 'projection must publish TDS_Lateness_Halt');
  assert.strictEqual(store.globals['TDS_Manual_Return_Completed'], 'true', 'projection must publish TDS_Manual_Return_Completed');

  const logs = parseLog(store);
  const delivered = logs.find(function (l) { return l.code === 'REDUCER_BATCH_DELIVERED'; });
  assert(delivered, 'reducer must log REDUCER_BATCH_DELIVERED');
  assert.strictEqual(delivered.details.count, 4, 'REDUCER_BATCH_DELIVERED must report the command count');
  assert.strictEqual(delivered.details.applied, 4, 'every sub-command must apply');
  assert.strictEqual(delivered.details.skipped, 0, 'no sub-command may be skipped');
});

// Base-leave pass: OBSERVE_BASE_LEAVE + OBSERVE_DEPARTURE + OBSERVE_STATUS +
// OBSERVE_LATENESS_HALT must all land — pre-fix both secondary observations
// are clobbered by last-wins.
section('base-leave-pass-delivers-departure-observation', function () {
  const itin = JSON.stringify([{
    tripId: 'today_leg', targetEventId: 'ev_leg_kx8f00', mode: 'DRIVE',
    departUnix: nowSec - 300, arriveUnix: nowSec + 2100, targetTitle: 'Work',
    targetCoords: awayCoords, planningDay: todayDay
  }]);
  const files = Object.assign({}, commonFiles, {
    [DATA + 'TDS_Master.json']: futureEvent,
    [DATA + 'Itin_Master.json']: itin,
    [STATE]: seededState({}, { userAtBase: true, baseArrivalUnix: nowSec - 3600 })
  });
  const globals = Object.assign({}, arrivalGlobals, { User_At_Base: 'true', User_Loc: awayCoords });
  const locals = { idx: '1', virtual_loc: awayCoords, vcar_loc: awayCoords, virtual_time: String(nowSec) };
  const { sandbox, store } = make(files, globals, locals);
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  assert.strictEqual(store.locals.par1, 'REDUCER_BATCH',
    'staged par1 must be REDUCER_BATCH (last-wins pre-fix: got ' + store.locals.par1 + ')');
  const envelope = JSON.parse(store.locals.par2);
  assert.deepStrictEqual(envelope.commands.map(function (c) { return c.command; }),
    ['OBSERVE_BASE_LEAVE', 'OBSERVE_DEPARTURE', 'OBSERVE_STATUS', 'OBSERVE_LATENESS_HALT'],
    'base-leave batch must preserve staging order');

  const rv = sandbox.stateCommand('REDUCER_BATCH', envelope);
  assert.strictEqual(rv, 'OK', 'REDUCER_BATCH must be accepted: ' + rv);

  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.userAtBase, false, 'OBSERVE_BASE_LEAVE must clear userAtBase');
  assert.strictEqual(state.baseArrivalUnix, null, 'OBSERVE_BASE_LEAVE must clear baseArrivalUnix');
  const leg = state.trips.ev_leg_kx8f00;
  assert(leg, 'OBSERVE_DEPARTURE must record the head leg trip');
  assert(leg.departures && leg.departures.length === 1 && leg.departures[0].at === nowSec,
    'OBSERVE_DEPARTURE must store the departure record');
  assert.strictEqual(leg.lifecycleState, 'IN_PROGRESS', 'observed departure must activate the leg');
  assert.strictEqual(state.currentStatus, 'Lift', 'OBSERVE_STATUS must set the driving status');
  assert.strictEqual(store.globals['User_At_Base'], 'false', 'projection must publish the cleared base state');
});

// ---------------------------------------------------------------------
try {
  console.log('Serial batch FU1 regression suite:');
  if (failures.length > 0) {
    console.log('FAILED SECTIONS: ' + failures.length);
    console.log('FAIL: serial-batch — ' + failures[0]);
    process.exit(1);
  }
  console.log('PASS: serial-batch — REDUCER_BATCH delivers every staged observation in order');
  process.exit(0);
} catch (e) {
  console.log('FAIL: serial-batch — ' + e.message);
  process.exit(1);
}
