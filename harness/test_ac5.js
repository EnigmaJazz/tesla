// AC-5 / 0E / INV-0.4: post-return isolation regression test (Slice B).
//
// Covers: reducer COMPLETE_TRIP (completion, idempotence, exact-trip
// mutation, tomorrow PLANNED/JIT preservation), Dispatcher future-day
// rejection (EVT-FUTURE_TRIP_NOT_DUE), Sandbox synthetic-return suppression
// (EVT-SYNTHETIC_RETURN_SUPPRESSED), and the migration-only action lock
// (REQ-4SESSION-2): only the Manual Action Handler clears it, via RELEASE
// after session completion; Finaliser/Unlock can no longer clear it, and the
// Manual Action Handler is the sole writer of TDS_Action_Sessions.json.

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
const LOCK = DATA + 'TDS_Action_Lock.json';
const SESSIONS = DATA + 'TDS_Action_Sessions.json';
const GEN_ID = 'gen:1700000000:ab12';
const homeCoords = '51.9,-2.1';
const awayCoords = '52.45,-2.1';

const REDUCER = path.resolve(__dirname, '..', 'Trip_State_Reducer.js');
const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
const FINALISER = path.resolve(__dirname, '..', 'Finaliser.js');
const UNLOCK = path.resolve(__dirname, '..', 'Unlock.js');

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
    schemaVersion: 1,
    revision: 0,
    generationId: GEN_ID,
    currentOrigin: 'PLANNED',
    currentPlanningDay: '',
    userAtBase: false,
    baseArrivalUnix: null,
    latenessHalt: false,
    currentStatus: '',
    manualReturnCompleted: false,
    trips: trips || {},
    stops: {},
    manualSessions: {}
  }, extra || {}));
}

function make(files, globals, locals, nowMs) {
  return createSandbox({
    files: files || {},
    globals: globals || {},
    locals: locals || {},
    nowMs: (typeof nowMs === 'number') ? nowMs : nowSec * 1000
  });
}

function runReducer(sandbox, store, command, payload) {
  const result = sandbox.reducer(command, payload);
  if (store.runError) throw new Error(store.runError.message);
  return result;
}

function parseLog(store) {
  return store.flashLog.map(function (f) { return JSON.parse(f); });
}

function fail(msg) {
  console.log('FAIL: AC-5 — ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Section 1: reducer completion, idempotence, exact-trip mutation,
// and tomorrow PLANNED/JIT preservation.
// ---------------------------------------------------------------------
section('reducer-completion', function () {
  const { sandbox, store } = make();
  runReducer(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: GEN_ID, tripId: 'today_ret', at: nowSec - 1800, planningDay: todayDay });
  const r = runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 'today_ret', at: nowSec, planningDay: todayDay });
  assert.strictEqual(r, 'OK', 'COMPLETE_TRIP must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.today_ret.lifecycleState, 'COMPLETED', 'IN_PROGRESS trip must become COMPLETED');
  assert.strictEqual(state.trips.today_ret.completedUnix, nowSec, 'completedUnix must be set');
  assert.strictEqual(state.trips.today_ret.lastActivityUnix, nowSec, 'lastActivityUnix must be updated');
  assert.strictEqual(state.revision, 2, 'revision must increment for departure + completion');
});

section('reducer-idempotence', function () {
  const { sandbox, store } = make();
  runReducer(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: GEN_ID, tripId: 't1', at: nowSec - 1800, planningDay: todayDay });
  runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 't1', at: nowSec });
  const r2 = runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 't1', at: nowSec + 60 });
  assert.strictEqual(r2, 'OK', 'repeat COMPLETE_TRIP must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.t1.lifecycleState, 'COMPLETED', 'lifecycle stays COMPLETED');
  assert.strictEqual(state.trips.t1.completedUnix, nowSec, 'completedUnix must not be overwritten by repeat completion');
  assert.strictEqual(state.revision, 2, 'repeat completion must be a no-op (revision unchanged)');
});

section('reducer-exact-mutation', function () {
  const trips = {
    today_ret: { tripId: 'today_ret', lifecycleState: 'IN_PROGRESS', departures: [{ at: nowSec - 1800, planningDay: todayDay }], completedStops: [], completedDropins: [], lastActivityUnix: nowSec - 1800, currentPlanningDay: todayDay },
    other_arrived: { tripId: 'other_arrived', lifecycleState: 'ARRIVED', departures: [{ at: nowSec - 5400, planningDay: todayDay }], completedStops: [], completedDropins: [], lastActivityUnix: nowSec - 5400, currentPlanningDay: todayDay },
    tomorrow_trip: { tripId: 'tomorrow_trip', lifecycleState: 'PLANNED', departures: [], completedStops: [], completedDropins: [], lastActivityUnix: null, currentPlanningDay: tomorrowDay }
  };
  const { sandbox, store } = make({ [STATE]: seededState(trips) });
  const r = runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 'today_ret', at: nowSec, planningDay: todayDay });
  assert.strictEqual(r, 'OK', 'COMPLETE_TRIP must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.today_ret.lifecycleState, 'COMPLETED', 'matched IN_PROGRESS trip must complete');
  assert.strictEqual(state.trips.other_arrived.lifecycleState, 'ARRIVED', 'unmatched ARRIVED trip must be untouched');
  assert.strictEqual(state.trips.tomorrow_trip.lifecycleState, 'PLANNED', 'tomorrow PLANNED trip must be untouched');
});

section('reducer-tomorrow-preserved', function () {
  const trips = {
    today_ret: { tripId: 'today_ret', lifecycleState: 'ARRIVED', departures: [{ at: nowSec - 3600, planningDay: todayDay }], completedStops: [], completedDropins: [], lastActivityUnix: nowSec - 3600, currentPlanningDay: todayDay },
    tomorrow_trip: { tripId: 'tomorrow_trip', lifecycleState: 'PLANNED', departures: [], completedStops: [], completedDropins: [], lastActivityUnix: null, currentPlanningDay: tomorrowDay }
  };
  const before = JSON.parse(seededState(trips));
  const { sandbox, store } = make({ [STATE]: seededState(trips) });
  runReducer(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 'today_ret', at: nowSec, planningDay: todayDay });
  const state = JSON.parse(store.files[STATE]);
  assert.deepStrictEqual(state.trips.tomorrow_trip, before.trips.tomorrow_trip, 'tomorrow trip object must be byte-identical after completion');
  assert.strictEqual(state.trips.tomorrow_trip.lifecycleState, 'PLANNED', 'tomorrow must stay PLANNED');
  assert.strictEqual(state.trips.tomorrow_trip.currentPlanningDay, tomorrowDay, 'tomorrow planningDay label preserved');
});

// ---------------------------------------------------------------------
// Section 2: Dispatcher future-day rejection (REQ-AC5-2).
// ---------------------------------------------------------------------
const dispatcherGlobals = {
  Tesla_Last_Scheduled: '0',
  Tesla_Last_HVAC_Unix: '0',
  Tesla_Last_Nav: '',
  Google_Last_Nav: '',
  Current_Status: '',
  User_At_AdHoc: '',
  TDS_Active_Generation: GEN_ID
};

section('dispatcher-future-day-rejection', function () {
  const itin = JSON.stringify([{
    tripId: 'tomorrow_trip',
    targetEventId: 'ev_tomorrow',
    mode: 'DRIVE',
    departUnix: nowSec + 86400,
    arriveUnix: nowSec + 86400 + 3600,
    targetTitle: 'Work',
    targetCoords: '52.1,-2.2',
    planningDay: tomorrowDay
  }]);
  const { sandbox, store } = make({ [DATA + 'Itin_Master.json']: itin }, dispatcherGlobals, {});
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  assert.strictEqual(sandbox.local('itin_mode1'), 'NONE', 'future-day leg must not be selected');
  assert.strictEqual(sandbox.local('itin_time1'), '0', 'future-day leg must not populate timing');

  const logs = parseLog(store);
  const futureFlash = logs.find(function (l) { return l.code === 'FUTURE_TRIP_NOT_DUE'; });
  assert(futureFlash, 'Dispatcher must log EVT-FUTURE_TRIP_NOT_DUE');
  assert.strictEqual(futureFlash.tripId, 'tomorrow_trip', 'future-trip log must name the trip');
  assert.strictEqual(futureFlash.details.planningDay, tomorrowDay, 'future-trip log must include the planning day');

  const idle = logs.find(function (l) { return l.code === 'IDLE_SYNC_ENGAGED'; });
  assert(idle, 'Dispatcher must fall back to idle sync when the only candidate is future-day');
});

section('dispatcher-today-still-selected', function () {
  // Control: a same-day JIT leg must still be selected; no future-trip log.
  const itin = JSON.stringify([{
    tripId: 'today_trip',
    targetEventId: 'ev_today',
    mode: 'DRIVE',
    departUnix: nowSec + 3600,
    arriveUnix: nowSec + 5400,
    targetTitle: 'Work',
    targetCoords: '52.1,-2.2',
    planningDay: todayDay
  }]);
  const { sandbox, store } = make({ [DATA + 'Itin_Master.json']: itin }, dispatcherGlobals, {});
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  assert.strictEqual(sandbox.local('itin_mode1'), 'DRIVE', 'same-day leg must still be selected');
  const logs = parseLog(store);
  const futureFlash = logs.find(function (l) { return l.code === 'FUTURE_TRIP_NOT_DUE'; });
  assert(!futureFlash, 'same-day leg must not emit EVT-FUTURE_TRIP_NOT_DUE');
});

// ---------------------------------------------------------------------
// Section 3: Sandbox synthetic-return suppression (REQ-INV0_4-1).
// ---------------------------------------------------------------------
const baseGeocodes = [nowSec.toString(), (nowSec + 86400).toString(), homeCoords, '0', 'Home', '', 'home_base'].join('~');
const sandboxCommonFiles = {
  [DATA + 'Itin_Master.json']: '[]',
  [DATA + 'TDS_Base_Geocodes.txt']: baseGeocodes,
  [DATA + 'TDS_Overrides.json']: '{}',
  [DATA + 'Temp_Route_Cache.txt']: '',
  [DATA + 'RouteCache.txt']: ''
};

section('sandbox-synthetic-return-suppression', function () {
  // Only an _OUT observation exists (movement, no planned travel) and the
  // user is away from base: the engine must NOT synthesize a return leg and
  // MUST log EVT-SYNTHETIC_RETURN_SUPPRESSED.
  const outEvent = JSON.stringify([{
    id: 'walk_out_kx8f03',
    start: nowSec + 600,
    end: nowSec + 1200,
    duration: 600,
    title: 'Walk',
    desc: '#leave:5',
    loc: 'Park',
    coords: awayCoords
  }]);
  const files = Object.assign({}, sandboxCommonFiles, { [DATA + 'TDS_Master.json']: outEvent });
  const globals = {
    User_At_Base: 'false',
    Base_Arrival_Unix: '0',
    User_Loc: awayCoords,
    Home_Coords: homeCoords,
    Current_Status: 'Updating',
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5',
    Max_Walk_Meters: '8046',
    Daily_Walk_Meters: '0',
    Live_Traffic_Threshold: '7200',
    Car_Connected: 'false',
    TDS_Active_Generation: GEN_ID
  };
  const locals = { idx: '1', virtual_loc: awayCoords, vcar_loc: awayCoords, virtual_time: String(nowSec) };
  const { sandbox, store } = make(files, globals, locals);
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  const queue = store.locals['block_queue'];
  if (!queue || queue === 'EOF') throw new Error('expected a non-EOF block_queue for an _OUT-only day');
  const rows = queue.split('~');
  rows.forEach(function (row, i) {
    const type = row.split('|')[0];
    assert.notStrictEqual(type, 'EOD_RETURN', 'row ' + i + ' must not be a synthetic EOD_RETURN');
  });

  const logs = parseLog(store);
  const suppressFlash = logs.find(function (l) { return l.code === 'SYNTHETIC_RETURN_SUPPRESSED'; });
  assert(suppressFlash, 'Sandbox must log EVT-SYNTHETIC_RETURN_SUPPRESSED');
  assert(typeof suppressFlash.details === 'object' && suppressFlash.details, 'suppression log must carry details');
});

// ---------------------------------------------------------------------
// Section 4: Sandbox completion observer (REQ-AC5-1) — base arrival
// submits COMPLETE_TRIP and leaves tomorrow PLANNED.
// ---------------------------------------------------------------------
section('sandbox-completion-observer', function () {
  const seededTrips = {
    today_ret: { tripId: 'today_ret', lifecycleState: 'IN_PROGRESS', departures: [{ at: nowSec - 1800, planningDay: todayDay }], completedStops: [], completedDropins: [], lastActivityUnix: nowSec - 1800, currentPlanningDay: todayDay },
    tomorrow_trip: { tripId: 'tomorrow_trip', lifecycleState: 'PLANNED', departures: [], completedStops: [], completedDropins: [], lastActivityUnix: null, currentPlanningDay: tomorrowDay }
  };
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
  const files = Object.assign({}, sandboxCommonFiles, {
    [DATA + 'TDS_Master.json']: futureEvent,
    [STATE]: seededState(seededTrips)
  });
  const globals = {
    User_At_Base: 'false',
    Base_Arrival_Unix: '0',
    User_Loc: homeCoords,
    Home_Coords: homeCoords,
    Current_Status: 'Updating',
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5',
    Max_Walk_Meters: '8046',
    Daily_Walk_Meters: '0',
    Live_Traffic_Threshold: '7200',
    Car_Connected: 'false',
    TDS_Active_Generation: GEN_ID
  };
  const locals = { idx: '1', virtual_loc: homeCoords, vcar_loc: homeCoords, virtual_time: String(nowSec) };
  const { sandbox, store } = make(files, globals, locals);
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  const raw = store.files[STATE];
  assert(raw, 'Sandbox base arrival must drive a reducer state write');
  const state = JSON.parse(raw);
  assert.strictEqual(state.trips.today_ret.lifecycleState, 'COMPLETED', 'base arrival must complete the active manual return');
  assert.strictEqual(state.trips.today_ret.completedUnix, nowSec, 'completedUnix must reflect arrival time');
  assert.strictEqual(state.trips.tomorrow_trip.lifecycleState, 'PLANNED', 'tomorrow trip must stay PLANNED after completion');
  assert.strictEqual(state.trips.tomorrow_trip.currentPlanningDay, tomorrowDay, 'tomorrow planningDay label preserved');
});

// ---------------------------------------------------------------------
// Section 5: migration-only lock (REQ-4SESSION-2). The Manual Action Handler
// is the sole lock clearer (via RELEASE after session completion) and the
// sole writer of TDS_Action_Sessions.json; Finaliser/Unlock can no longer
// clear the lock and never write sessions.
// ---------------------------------------------------------------------
const staleLock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 10000, eventId: 'today_ret' });
const finaliserGlobals = {
  User_Loc: homeCoords,
  User_At_Base: 'true',
  TDS_Previous_Loc: homeCoords,
  TDS_Completed_Dropins: '',
  TDS_Arrival_Memory: '',
  Engine_Output_Itinerary: '[]',
  TDS_Active_Generation: GEN_ID
};
const ACTION_ID = 'action_' + nowSec.toString(36);
const TRIP_ID = 'manual_return_' + nowSec.toString(36);
const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');

function runRelease(sandbox, store, payload) {
  sandbox.__currentScriptPath = STATE_COMMAND;
  sandbox.setLocal('par1', 'RELEASE');
  sandbox.setLocal('par2', JSON.stringify(payload));
  runScript(STATE_COMMAND, sandbox, store);
  sandbox.__currentScriptPath = '';
  if (store.runError) throw new Error(store.runError.message);
  return sandbox.local('return_value');
}

section('lock-cleanup-finaliser-gated', function () {
  // Reducer state WITHOUT completion: the stale lock must NOT be cleared.
  const files = {
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}',
    [LOCK]: staleLock,
    [STATE]: seededState({})
  };
  const { sandbox, store } = make(files, finaliserGlobals, { tds_temp_json: '[]', raw_base_data: '' });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  const after = store.files[LOCK];
  assert.strictEqual(after, staleLock, 'Finaliser must NOT clear the lock without reducer completion');
  const sessionWrite = store.writeLog.some(function (w) { return w.path === SESSIONS; });
  assert(!sessionWrite, 'Finaliser must not write TDS_Action_Sessions.json');
});

section('lock-cleanup-finaliser-handler-only', function () {
  // After COMPLETE_TRIP succeeded (manualReturnCompleted), Finaliser STILL
  // cannot clear the migration-only lock — only the Manual Action Handler may.
  const completedState = JSON.parse(seededState({}));
  completedState.manualReturnCompleted = true;
  const files = {
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}',
    [LOCK]: staleLock,
    [STATE]: JSON.stringify(completedState)
  };
  const { sandbox, store } = make(files, finaliserGlobals, { tds_temp_json: '[]', raw_base_data: '' });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  assert.strictEqual(store.files[LOCK], staleLock, 'Finaliser must NOT clear the migration-only lock');
  assert(store.flashLog.some(function (f) { return f.indexOf('UNAUTHORIZED_WRITE_REJECTED') !== -1; }),
    'Finaliser lock-clear attempt must be rejected');
  const sessionWrite = store.writeLog.some(function (w) { return w.path === SESSIONS; });
  assert(!sessionWrite, 'Finaliser must not write TDS_Action_Sessions.json');
});

section('unlock-cannot-clear-lock', function () {
  // Unlock without reducer completion: lock must survive.
  const { sandbox: s1, store: st1 } = make({ [LOCK]: staleLock, [STATE]: seededState({}) }, {}, {});
  runScript(UNLOCK, s1, st1);
  if (st1.runError) throw new Error(st1.runError.message);
  assert.strictEqual(st1.files[LOCK], staleLock, 'Unlock must not clear the lock without reducer completion');
  assert(!st1.writeLog.some(function (w) { return w.path === SESSIONS; }), 'Unlock must not write TDS_Action_Sessions.json');

  // Unlock after completion: the lock STILL survives — handler-only clearing.
  const completedState = JSON.parse(seededState({}));
  completedState.manualReturnCompleted = true;
  const { sandbox: s2, store: st2 } = make({ [LOCK]: staleLock, [STATE]: JSON.stringify(completedState) }, {}, {});
  runScript(UNLOCK, s2, st2);
  if (st2.runError) throw new Error(st2.runError.message);
  assert.strictEqual(st2.files[LOCK], staleLock, 'Unlock must NOT clear the migration-only lock');
  assert(!st2.writeLog.some(function (w) { return w.path === SESSIONS; }), 'Unlock must not write TDS_Action_Sessions.json');
});

section('release-clears-lock-and-keeps-tomorrow-planned', function () {
  // RELEASE (Manual Action Handler) closes the exact session/manual trip and
  // clears the matching legacy lock with EVT LOCK_COMPATIBILITY_CLEARED;
  // tomorrow's trip in reducer state stays byte-identical PLANNED.
  const trips = {
    today_ret: { tripId: 'today_ret', actionId: ACTION_ID, lifecycleState: 'IN_PROGRESS', departures: [{ at: nowSec - 1800, planningDay: todayDay }], currentPlanningDay: todayDay },
    tomorrow_trip: { tripId: 'tomorrow_trip', lifecycleState: 'PLANNED', departures: [], currentPlanningDay: tomorrowDay }
  };
  const sessions = { schemaVersion: 1, sessions: { [ACTION_ID]: { actionId: ACTION_ID, tripId: TRIP_ID, status: 'ACTIVE', closedAt: null, closeReason: null } } };
  const manualTrips = { schemaVersion: 1, trips: { [TRIP_ID]: { tripId: TRIP_ID, actionId: ACTION_ID, lifecycleState: 'IN_PROGRESS' } } };
  const before = JSON.parse(seededState(trips));
  const matchingLock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 10000, eventId: TRIP_ID });
  const files = {
    [STATE]: seededState(trips),
    [SESSIONS]: JSON.stringify(sessions),
    [DATA + 'TDS_Manual_Trips.json']: JSON.stringify(manualTrips),
    [LOCK]: matchingLock
  };
  const { sandbox, store } = make(files, {}, {});
  const r = runRelease(sandbox, store, { actionId: ACTION_ID, tripId: TRIP_ID, at: nowSec });
  assert(r.indexOf('OK') === 0, 'RELEASE must be accepted by the Manual Action Handler: ' + r);
  assert.strictEqual(store.files[LOCK], '{}', 'RELEASE must clear the matching legacy lock');
  assert.strictEqual(JSON.parse(store.files[SESSIONS]).sessions[ACTION_ID].status, 'CLOSED', 'RELEASE must close the exact session');
  const logs = store.flashLog.map(function (f) { return JSON.parse(f); });
  assert(logs.some(function (l) { return l.code === 'LOCK_COMPATIBILITY_CLEARED'; }), 'RELEASE must log LOCK_COMPATIBILITY_CLEARED');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.today_ret.lifecycleState, 'IN_PROGRESS', 'RELEASE must not touch reducer trip lifecycle');
  assert.deepStrictEqual(state.trips.tomorrow_trip, before.trips.tomorrow_trip, 'tomorrow trip must stay byte-identical PLANNED');
});

// ---------------------------------------------------------------------
try {
  console.log('AC-5 Slice B regression suite:');
  if (failures.length > 0) {
    console.log('FAILED SECTIONS: ' + failures.length);
    fail(failures[0]);
  }
  console.log('PASS: AC-5 — completion isolation, future-day rejection, suppression, handler-only lock cleanup');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
