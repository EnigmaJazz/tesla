// FU2 RED → GREEN (REQ-6FU-5, SCN-6FU-10/11): non-base-origin departure
// observation in the Sandbox active-leg window, once per leg.
//
// The only production caller of OBSERVE_DEPARTURE is the base-leave branch
// (gated on !currentlyAtBase && prevAtBase — a transition out of base). A JIT
// head leg starting from a non-base origin (vehicle already away:
// currentlyAtBase=false AND prevAtBase=false) never matches that branch, so
// its departure is never observed and the cross-day departChanged/
// departDiffMins baseline stays silent.
//
// This suite proves the FU2 edge: when the head leg enters its departure
// window while the vehicle is already away, OBSERVE_DEPARTURE is staged (with
// the head leg's targetEventId) and delivered through the FU1 REDUCER_BATCH
// envelope; repeated passes do NOT pollute departures[] (once-per-leg guard);
// and a base-leave departure is never double-observed across passes.
//
// RED baseline: pre-fix the non-base pass stages no OBSERVE_DEPARTURE — the
// batch is [OBSERVE_STATUS, OBSERVE_LATENESS_HALT] and the first assertion
// fails. GREEN: the edge fires once and the guard suppresses re-staging.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;                    // 2023-11-14T22:13:20Z
const todayDay = '2023-11-14';
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

// The head leg is in its departure window at nowSec: departUnix = nowSec - 300
// (leaveSec - 600 <= nowSec) and latestValidDepart = leaveSec + 3600
// (targetEventId not in master, so the +3600 fallback holds).
const itin = JSON.stringify([{
  tripId: 'today_leg', targetEventId: 'ev_leg_kx8f00', mode: 'DRIVE',
  departUnix: nowSec - 300, arriveUnix: nowSec + 2100, targetTitle: 'Work',
  targetCoords: awayCoords, planningDay: todayDay
}]);

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

function makeFiles(extra) {
  return Object.assign({
    [DATA + 'TDS_Master.json']: futureEvent,
    [DATA + 'Itin_Master.json']: itin,
    [DATA + 'TDS_Base_Geocodes.txt']: baseGeocodes,
    [DATA + 'TDS_Overrides.json']: '{}',
    [DATA + 'Temp_Route_Cache.txt']: '',
    [DATA + 'RouteCache.txt']: ''
  }, extra || {});
}

// Vehicle already away: User_At_Base=false (prevAtBase=false) and the head leg
// is inside its departure window. The FU2 edge is the ONLY site that can
// observe this departure.
const awayGlobals = {
  User_At_Base: 'false', Base_Arrival_Unix: '0', User_Loc: awayCoords,
  Home_Coords: homeCoords, Current_Status: 'Updating', Arrival_Buffer_Mins: '5',
  Departure_Buffer_Mins: '5', Max_Walk_Meters: '8046', Daily_Walk_Meters: '0',
  Live_Traffic_Threshold: '7200', Car_Connected: 'false', TDS_Active_Generation: GEN_ID
};
const awayLocals = { idx: '1', virtual_loc: awayCoords, vcar_loc: awayCoords, virtual_time: String(nowSec) };

// SCN-6FU-10: non-base head leg in window → OBSERVE_DEPARTURE staged in the
// batch with the head leg's targetEventId, delivered by ONE router call, and
// the reducer stores it (lifecycleState IN_PROGRESS).
section('non-base-head-leg-in-window-stages-departure-once', function () {
  const files = makeFiles({ [STATE]: seededState({}) });
  const { sandbox, store } = make(files, awayGlobals, awayLocals);
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  assert.strictEqual(store.locals.par1, 'REDUCER_BATCH',
    'non-base pass must stage the REDUCER_BATCH envelope (RED pre-fix: got ' + store.locals.par1 + ')');
  const envelope = JSON.parse(store.locals.par2);
  const depCmds = envelope.commands.filter(function (c) { return c.command === 'OBSERVE_DEPARTURE'; });
  assert.strictEqual(depCmds.length, 1,
    'non-base window entry must stage exactly one OBSERVE_DEPARTURE (RED pre-fix: got ' + depCmds.length + ')');
  assert.strictEqual(depCmds[0].payload.tripId, 'ev_leg_kx8f00',
    'OBSERVE_DEPARTURE must carry the head leg targetEventId');
  assert.strictEqual(depCmds[0].payload.planningDay, todayDay,
    'OBSERVE_DEPARTURE must carry the current planning day');
  assert.deepStrictEqual(envelope.commands.map(function (c) { return c.command; }),
    ['OBSERVE_DEPARTURE', 'OBSERVE_STATUS', 'OBSERVE_LATENESS_HALT'],
    'staging order: departure edge fires before OBSERVE_STATUS and the halt reset');

  // ONE serial TDS_State_Command invocation delivers the whole batch.
  const rv = sandbox.stateCommand('REDUCER_BATCH', envelope);
  assert.strictEqual(rv, 'OK', 'REDUCER_BATCH must be accepted by the router: ' + rv);

  const state = JSON.parse(store.files[STATE]);
  const leg = state.trips['ev_leg_kx8f00'];
  assert(leg, 'OBSERVE_DEPARTURE must create the trip record');
  assert(leg.departures && leg.departures.length === 1,
    'exactly one departure record must land (got ' + (leg.departures || []).length + ')');
  assert.strictEqual(leg.departures[0].at, nowSec, 'departure record must carry the observation time');
  assert.strictEqual(leg.departures[0].planningDay, todayDay, 'departure record must carry the planning day');
  assert.strictEqual(leg.lifecycleState, 'IN_PROGRESS', 'observed departure must activate the leg');
  assert.strictEqual(state.currentStatus, 'Lift', 'OBSERVE_STATUS must set the driving status');
});

// SCN-6FU-11: once-per-leg guard — a second pass with the same day's record
// already in trip state must NOT re-stage OBSERVE_DEPARTURE and must not
// pollute departures[].
section('re-entry-does-not-restage-departure', function () {
  // Pass 1: deliver the departure observation.
  const files1 = makeFiles({ [STATE]: seededState({}) });
  const { sandbox: sb1, store: st1 } = make(files1, awayGlobals, awayLocals);
  runScript(SANDBOX, sb1, st1);
  if (st1.runError) throw new Error(st1.runError.message);
  const env1 = JSON.parse(st1.locals.par2);
  const rv1 = sb1.stateCommand('REDUCER_BATCH', env1);
  assert.strictEqual(rv1, 'OK', 'pass 1 REDUCER_BATCH must be accepted: ' + rv1);
  const stateAfterPass1 = JSON.parse(st1.files[STATE]);
  assert.strictEqual(stateAfterPass1.trips['ev_leg_kx8f00'].departures.length, 1, 'pass 1 must record one departure');

  // Pass 2: same day, same window, trip state already holds today's record.
  const files2 = makeFiles({ [STATE]: JSON.stringify(stateAfterPass1) });
  const { sandbox: sb2, store: st2 } = make(files2, awayGlobals, awayLocals);
  runScript(SANDBOX, sb2, st2);
  if (st2.runError) throw new Error(st2.runError.message);

  const env2 = JSON.parse(st2.locals.par2);
  const depCmds2 = env2.commands.filter(function (c) { return c.command === 'OBSERVE_DEPARTURE'; });
  assert.strictEqual(depCmds2.length, 0,
    're-entry must not re-stage OBSERVE_DEPARTURE (once-per-leg guard; got ' + depCmds2.length + ')');
  assert.deepStrictEqual(env2.commands.map(function (c) { return c.command; }),
    ['OBSERVE_STATUS', 'OBSERVE_LATENESS_HALT'],
    'pass 2 must stage only status + halt reset');

  const rv2 = sb2.stateCommand('REDUCER_BATCH', env2);
  assert.strictEqual(rv2, 'OK', 'pass 2 REDUCER_BATCH must be accepted: ' + rv2);
  const stateAfterPass2 = JSON.parse(st2.files[STATE]);
  assert.strictEqual(stateAfterPass2.trips['ev_leg_kx8f00'].departures.length, 1,
    'departures[] must not be polluted by re-entry');
});

// SCN-6FU-11: a base-leave departure must never be double-observed — the
// base-leave pass stages OBSERVE_DEPARTURE exactly once, and a subsequent
// away pass (prevAtBase now false) must not re-stage it.
section('base-leave-departure-not-double-observed', function () {
  const baseLeaveGlobals = Object.assign({}, awayGlobals, { User_At_Base: 'true', Base_Arrival_Unix: String(nowSec - 3600) });

  // Pass 1: base-leave — prevAtBase=true, so the base-leave branch (not the
  // FU2 edge) owns the departure observation.
  const files1 = makeFiles({ [STATE]: seededState({}, { userAtBase: true, baseArrivalUnix: nowSec - 3600 }) });
  const { sandbox: sb1, store: st1 } = make(files1, baseLeaveGlobals, awayLocals);
  runScript(SANDBOX, sb1, st1);
  if (st1.runError) throw new Error(st1.runError.message);

  const env1 = JSON.parse(st1.locals.par2);
  const depCmds1 = env1.commands.filter(function (c) { return c.command === 'OBSERVE_DEPARTURE'; });
  assert.strictEqual(depCmds1.length, 1,
    'base-leave pass must stage exactly one OBSERVE_DEPARTURE (base-leave branch; got ' + depCmds1.length + ')');
  assert.deepStrictEqual(env1.commands.map(function (c) { return c.command; }),
    ['OBSERVE_BASE_LEAVE', 'OBSERVE_DEPARTURE', 'OBSERVE_STATUS', 'OBSERVE_LATENESS_HALT'],
    'base-leave pass must preserve the existing staging order');
  const rv1 = sb1.stateCommand('REDUCER_BATCH', env1);
  assert.strictEqual(rv1, 'OK', 'pass 1 REDUCER_BATCH must be accepted: ' + rv1);
  const stateAfterPass1 = JSON.parse(st1.files[STATE]);
  assert.strictEqual(stateAfterPass1.trips['ev_leg_kx8f00'].departures.length, 1, 'pass 1 must record one departure');

  // Pass 2: vehicle still away, User_At_Base now false (projected by the
  // reducer after OBSERVE_BASE_LEAVE) → prevAtBase=false → the FU2 edge
  // condition holds, but the guard must suppress it: the trip already carries
  // today's departure record.
  const awayGlobals2 = Object.assign({}, awayGlobals, { User_At_Base: 'false', Base_Arrival_Unix: '0' });
  const files2 = makeFiles({ [STATE]: JSON.stringify(stateAfterPass1) });
  const { sandbox: sb2, store: st2 } = make(files2, awayGlobals2, awayLocals);
  runScript(SANDBOX, sb2, st2);
  if (st2.runError) throw new Error(st2.runError.message);

  const env2 = JSON.parse(st2.locals.par2);
  const depCmds2 = env2.commands.filter(function (c) { return c.command === 'OBSERVE_DEPARTURE'; });
  assert.strictEqual(depCmds2.length, 0,
    'away pass after base-leave must not double-observe the departure (got ' + depCmds2.length + ')');
  const rv2 = sb2.stateCommand('REDUCER_BATCH', env2);
  assert.strictEqual(rv2, 'OK', 'pass 2 REDUCER_BATCH must be accepted: ' + rv2);
  const stateAfterPass2 = JSON.parse(st2.files[STATE]);
  assert.strictEqual(stateAfterPass2.trips['ev_leg_kx8f00'].departures.length, 1,
    'departures[] must stay at one record after the away pass');

  const logs = parseLog(st2);
  assert.strictEqual(logs.filter(function (l) { return l.code === 'OBSERVE_DEPARTURE_ACCEPTED'; }).length, 1,
    'exactly one departure accepted across both passes');
});

// ---------------------------------------------------------------------
try {
  console.log('FU2 non-base departure edge regression suite:');
  if (failures.length > 0) {
    console.log('FAILED SECTIONS: ' + failures.length);
    console.log('FAIL: fu2-departure-edge — ' + failures[0]);
    process.exit(1);
  }
  console.log('PASS: fu2-departure-edge — non-base departure observed once, guard holds');
  process.exit(0);
} catch (e) {
  console.log('FAIL: fu2-departure-edge — ' + e.message);
  process.exit(1);
}
