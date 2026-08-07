// Phase 4 Slice B RED — Manual Action Handler, typed depart/return, sessions.
// REQ-4ADAPTER-3/4 (SCN-4ADAPTER-3/4), REQ-4SESSION-1/2 (SCN-4SESSION-1/2).
//
// Fails on Slice A (current master): DEPART_NOW/RETURN_TO_BASE are reducer
// stubs, Depart_Now/Return_to_Base stage full publish candidates, sessions and
// manual trips have no owner, the router rejects the manual commands as
// pending, the legacy lock is authoritative for readers, and no write guards
// protect the session/manual-trip/lock resources.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;                    // 2023-11-14T22:13:20Z
const todayDay = '2023-11-14';
const tomorrowDay = '2023-11-15';
const DATA = 'Tasker/Tesla/Data/';
const STATE = DATA + 'TDS_Trip_State.json';
const SESSIONS = DATA + 'TDS_Action_Sessions.json';
const MANUAL_TRIPS = DATA + 'TDS_Manual_Trips.json';
const LOCK = DATA + 'TDS_Action_Lock.json';
const GEN_ID = 'gen:1700000000:ab12';
const GEN_ENC = GEN_ID.replace(/:/g, '_');
const homeCoords = '51.9,-2.1';
const awayCoords = '52.45,-2.1';
const B36 = nowSec.toString(36);
const ACTION_ID = 'action_' + B36;            // collision-safe underscore + base-36 suffix
const TRIP_ID = 'manual_return_' + B36;

const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');
const DEPART_NOW = path.resolve(__dirname, '..', 'Depart_Now.js');
const RETURN_TO_BASE = path.resolve(__dirname, '..', 'Return_to_Base.js');
const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');
const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
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

function make(files, globals, locals, opts) {
  return createSandbox(Object.assign({
    files: files || {},
    globals: globals || {},
    locals: locals || {},
    nowMs: nowSec * 1000
  }, opts || {}));
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

function runRouter(sandbox, store, command, payload) {
  sandbox.__currentScriptPath = STATE_COMMAND;
  sandbox.setLocal('par1', command);
  sandbox.setLocal('par2', JSON.stringify(payload));
  runScript(STATE_COMMAND, sandbox, store);
  sandbox.__currentScriptPath = '';
  if (store.runError) throw new Error(store.runError.message);
  return sandbox.local('return_value');
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

function manifest() {
  return JSON.stringify({
    schemaVersion: 1, generationId: GEN_ID, activeGeneration: GEN_ID, previousGeneration: null,
    publishedAt: nowSec, writer: 'Generation Publisher',
    eventsPath: DATA + 'TDS_Events.' + GEN_ENC + '.json',
    masterPath: DATA + 'TDS_Master.' + GEN_ENC + '.json',
    itineraryPath: DATA + 'Itin_Master.' + GEN_ENC + '.json',
    eventCount: 1, legCount: 1, itineraryCount: 1, generationHistory: [GEN_ID], state: 'committed'
  });
}

const retPayload = {
  generationId: GEN_ID, actionId: ACTION_ID, tripId: TRIP_ID, at: nowSec,
  policy: 'MANUAL', originCoords: awayCoords, targetCoords: homeCoords,
  targetTitle: 'Return to Base', mode: 'DRIVE', durationSecs: 1800,
  distanceMiles: 12.5, planningDay: todayDay
};

// ---------------------------------------------------------------------
// Section 1: typed adapter staging (REQ-4ADAPTER-3/4).
// ---------------------------------------------------------------------
section('adapter-depart-now-stages-typed', function () {
  const itin = JSON.stringify([{ tripId: 'today_leg', targetEventId: 'ev_x_kx8f00', mode: 'DRIVE',
    departUnix: nowSec + 600, arriveUnix: nowSec + 2400, targetTitle: 'Work', targetCoords: awayCoords }]);
  const files = { [DATA + 'TDS_Run_Manifest.json']: manifest(), [DATA + 'Itin_Master.' + GEN_ENC + '.json']: itin };
  const { sandbox, store } = make(files, { TDS_Active_Generation: GEN_ID });
  runScript(DEPART_NOW, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  // FU1 (REQ-6FU-4, SCN-6FU-8): one REDUCER_BATCH envelope with DEPART_NOW
  // LAST inside the batch — primary-last preserved, halt observation delivered.
  assert.strictEqual(sandbox.local('par1'), 'REDUCER_BATCH', 'Depart Now must stage the REDUCER_BATCH envelope');
  const env = JSON.parse(sandbox.local('par2'));
  assert.strictEqual(env.generationId, GEN_ID, 'batch must carry the active generation');
  assert.strictEqual(env.commands.length, 2, 'batch must carry halt + depart');
  assert.strictEqual(env.commands[0].command, 'OBSERVE_LATENESS_HALT', 'halt release must precede the primary');
  assert.strictEqual(env.commands[0].payload.halt, false, 'halt release must clear the halt');
  assert.strictEqual(env.commands[1].command, 'DEPART_NOW', 'primary DEPART_NOW must be the last sub-command');
  const payload = env.commands[1].payload;
  assert.strictEqual(payload.tripId, 'today_leg', 'DEPART_NOW must carry the selected leg trip id');
  assert.strictEqual(typeof payload.at, 'number', 'DEPART_NOW must carry a departure unix timestamp');
  assert.strictEqual(payload.generationId, GEN_ID, 'DEPART_NOW must carry the active generation');
  assert.strictEqual(store.writeLog.length, 0, 'Depart Now must not write any file (no candidate staging)');
});

section('adapter-return-to-base-stages-typed', function () {
  const globals = {
    TDS_Return_Coords: homeCoords, TDS_Return_Mode: 'DRIVE', TDS_Return_Name: 'Base',
    User_Loc: awayCoords, Car_Loc: awayCoords, TDS_Active_Generation: GEN_ID
  };
  const { sandbox, store } = make({ [DATA + 'TDS_Run_Manifest.json']: manifest() }, globals);
  runScript(RETURN_TO_BASE, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  // FU1 (REQ-6FU-4): one REDUCER_BATCH envelope with RETURN_TO_BASE LAST
  // inside the batch — both secondary observations delivered, primary last.
  assert.strictEqual(sandbox.local('par1'), 'REDUCER_BATCH', 'Return to Base must stage the REDUCER_BATCH envelope');
  const env = JSON.parse(sandbox.local('par2'));
  assert.strictEqual(env.commands.length, 3, 'batch must carry status + halt + return');
  assert.strictEqual(env.commands[0].command, 'OBSERVE_STATUS', 'status observation must precede the primary');
  assert.strictEqual(env.commands[1].command, 'OBSERVE_LATENESS_HALT', 'halt release must precede the primary');
  assert.strictEqual(env.commands[2].command, 'RETURN_TO_BASE', 'primary RETURN_TO_BASE must be the last sub-command');
  const payload = env.commands[2].payload;
  assert.strictEqual(payload.policy, 'MANUAL', 'RETURN_TO_BASE must carry an explicit return policy');
  assert(/^(action|manual_return)_[0-9a-z]+$/.test(payload.actionId) && /^manual_return_[0-9a-z]+$/.test(payload.tripId),
    'RETURN_TO_BASE must carry collision-safe underscore+base-36 ids');
  assert.strictEqual(payload.targetCoords, homeCoords, 'RETURN_TO_BASE must carry the base target');
  assert(payload.durationSecs > 0, 'RETURN_TO_BASE must carry positive route metrics');
  assert(payload.planningDay === todayDay, 'RETURN_TO_BASE must carry the local planning day');
  assert.strictEqual(store.writeLog.length, 0, 'Return to Base must not prepend a candidate or write any file');
});

// FU1 (REQ-6FU-4, SCN-6FU-8): the adapter batch must reach the reducer whole —
// the halt release AND the primary command both apply, neither sacrificed.
section('adapter-batch-delivers-halt-and-primary', function () {
  const itin = JSON.stringify([{ tripId: 'today_leg', targetEventId: 'ev_x_kx8f00', mode: 'DRIVE',
    departUnix: nowSec + 600, arriveUnix: nowSec + 2400, targetTitle: 'Work', targetCoords: awayCoords }]);
  const planned = { trips: {
    today_leg: { tripId: 'today_leg', lifecycleState: 'PLANNED', departUnix: nowSec + 600, arriveUnix: nowSec + 2400, durationSecs: 1800, currentPlanningDay: todayDay },
    other: { tripId: 'other', lifecycleState: 'PLANNED', departUnix: nowSec + 7200, arriveUnix: nowSec + 9000, durationSecs: 1800, currentPlanningDay: todayDay }
  } };
  const files = { [DATA + 'TDS_Run_Manifest.json']: manifest(), [DATA + 'Itin_Master.' + GEN_ENC + '.json']: itin, [STATE]: seededState(planned.trips) };
  const { sandbox, store } = make(files, { TDS_Active_Generation: GEN_ID });
  runScript(DEPART_NOW, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  const r = runRouter(sandbox, store, sandbox.local('par1'), JSON.parse(sandbox.local('par2')));
  assert.strictEqual(r, 'OK', 'Depart Now batch must be accepted by the router: ' + r);
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.today_leg.lifecycleState, 'IN_PROGRESS', 'DEPART_NOW must apply from the batch');
  assert.strictEqual(state.trips.today_leg.manualDeparture, true, 'DEPART_NOW must record manualDeparture');
  assert.strictEqual(state.trips.today_leg.actualDepartUnix, nowSec, 'DEPART_NOW must record actualDepartUnix');
  assert.strictEqual(state.trips.other.lifecycleState, 'PLANNED', 'unselected trips must stay untouched');
  assert.strictEqual(state.latenessHalt, false, 'OBSERVE_LATENESS_HALT must apply from the batch');

  // Return to Base: both observations + the manual trip + the SESSION_OPEN
  // staged by the reducer after the batch commits.
  const rGlobals = {
    TDS_Return_Coords: homeCoords, TDS_Return_Mode: 'DRIVE', TDS_Return_Name: 'Base',
    User_Loc: awayCoords, Car_Loc: awayCoords, TDS_Active_Generation: GEN_ID
  };
  const { sandbox: s2, store: st2 } = make({ [DATA + 'TDS_Run_Manifest.json']: manifest() }, rGlobals);
  runScript(RETURN_TO_BASE, s2, st2);
  if (st2.runError) throw new Error(st2.runError.message);
  const r2 = runRouter(s2, st2, s2.local('par1'), JSON.parse(s2.local('par2')));
  assert(r2.indexOf('OK') === 0, 'Return to Base batch must be accepted: ' + r2);
  const st = JSON.parse(st2.files[STATE]);
  assert(st.trips[TRIP_ID], 'RETURN_TO_BASE must record the manual trip from the batch');
  assert.strictEqual(st.currentStatus.indexOf('Heading Home') !== -1, true, 'OBSERVE_STATUS must apply from the batch');
  assert.strictEqual(st.latenessHalt, false, 'OBSERVE_LATENESS_HALT must apply from the batch');
  assert(JSON.parse(st2.files[SESSIONS]).sessions[ACTION_ID], 'SESSION_OPEN staged after the batch must open the session');
});

// ---------------------------------------------------------------------
// Section 2: typed reducer lifecycle (SCN-4ADAPTER-3).
// ---------------------------------------------------------------------
section('reducer-depart-now-only-selected', function () {
  const trips = {
    selected: { tripId: 'selected', lifecycleState: 'PLANNED', departUnix: nowSec + 3600, arriveUnix: nowSec + 5400, durationSecs: 1800, currentPlanningDay: todayDay },
    other: { tripId: 'other', lifecycleState: 'PLANNED', departUnix: nowSec + 7200, arriveUnix: nowSec + 9000, durationSecs: 1800, currentPlanningDay: todayDay }
  };
  const { sandbox, store } = make({ [STATE]: seededState(trips) });
  const r = runRouter(sandbox, store, 'DEPART_NOW', { generationId: GEN_ID, tripId: 'selected', at: nowSec });
  assert.strictEqual(r, 'OK', 'DEPART_NOW must be accepted');
  const state = JSON.parse(store.files[STATE]);
  const sel = state.trips.selected;
  assert.strictEqual(sel.lifecycleState, 'IN_PROGRESS', 'only the selected trip may become IN_PROGRESS');
  assert.strictEqual(sel.manualDeparture, true, 'selected trip must record manualDeparture');
  assert.strictEqual(sel.actualDepartUnix, nowSec, 'selected trip must record actualDepartUnix');
  assert.strictEqual(sel.estimatedArrivalUnix, nowSec + 1800, 'selected trip must record a separate estimated arrival');
  assert.strictEqual(sel.departUnix, nowSec + 3600, 'selected trip must preserve its planned departure');
  assert.strictEqual(state.trips.other.lifecycleState, 'PLANNED', 'unselected trips must stay untouched');
  assert.strictEqual(state.trips.other.manualDeparture, undefined, 'unselected trips must not gain manual departure flags');
});

// ---------------------------------------------------------------------
// Section 3: RETURN_TO_BASE opens a unique manual trip/session
// (REQ-4ADAPTER-4, REQ-4SESSION-1, SCN-4SESSION-1).
// ---------------------------------------------------------------------
section('return-to-base-opens-session', function () {
  const { sandbox, store } = make();
  const r = runRouter(sandbox, store, 'RETURN_TO_BASE', retPayload);
  assert(r.indexOf('OK') === 0, 'RETURN_TO_BASE must be accepted: ' + r);
  const state = JSON.parse(store.files[STATE]);
  assert(state.trips[TRIP_ID], 'reducer must record the manual trip');
  assert.strictEqual(state.trips[TRIP_ID].legType, 'MANUAL_RETURN', 'manual trip must be typed');
  assert.strictEqual(state.trips[TRIP_ID].lifecycleState, 'IN_PROGRESS', 'manual trip must be actionable immediately');
  assert.strictEqual(state.trips[TRIP_ID].originSource, 'ACTIVE_MANUAL_TRIP', 'manual trip must declare its origin');
  assert.strictEqual(state.trips[TRIP_ID].actionId, ACTION_ID, 'manual trip must link its action session');

  const sessions = JSON.parse(store.files[SESSIONS]);
  const session = sessions.sessions[ACTION_ID];
  assert(session, 'session file must carry the opened session');
  assert.strictEqual(session.actionId, ACTION_ID);
  assert.strictEqual(session.tripId, TRIP_ID, 'session must link the manual trip');
  assert.strictEqual(session.status, 'ACTIVE');
  assert.strictEqual(session.type, 'MANUAL_RETURN');
  assert(session.scopes.indexOf('PRESERVE_ACTIVE_TRIP') !== -1, 'session must carry source action scopes');
  assert.strictEqual(session.closedAt, null);

  const trips = JSON.parse(store.files[MANUAL_TRIPS]);
  assert(trips.trips[TRIP_ID], 'manual trips file must carry the unique manual trip');
  assert.strictEqual(trips.trips[TRIP_ID].actionId, ACTION_ID);
  assert.strictEqual(trips.trips[TRIP_ID].durationSecs, 1800);
  assert.strictEqual(trips.trips[TRIP_ID].relevanceDeadlineUnix, nowSec + 4 * 3600, 'manual trip must carry an explicit relevance deadline');

  const logs = parseLog(store);
  const opened = logs.find(function (l) { return l.code === 'SESSION_OPENED'; });
  assert(opened && logFieldsOk(opened), 'SESSION_OPENED must be logged with all LOG-17 fields');
  assert.strictEqual(opened.details.actionId, ACTION_ID, 'SESSION_OPENED must name the action');

  assert(!store.writeLog.some(function (w) { return w.path.indexOf('Itin_Master') !== -1 || w.path.indexOf('TDS_Run_Manifest') !== -1; }),
    'opening a session must not replace any itinerary');
});

section('session-open-collision-safe-ids', function () {
  // Same second, same provided ids -> the handler re-mints a later second
  // (bounded retry) instead of failing with SESSION_ID_COLLISION
  // (REQ-4SESSION-1 collision safety). Each router run gets a fresh sandbox
  // (vm context is shared per sandbox, so a script runs at most once per
  // sandbox); file state carries over.
  const s1 = make();
  const r1 = runRouter(s1.sandbox, s1.store, 'RETURN_TO_BASE', retPayload);
  assert(r1.indexOf('OK') === 0, 'first RETURN_TO_BASE must be accepted: ' + r1);
  const s2 = make({ [MANUAL_TRIPS]: s1.store.files[MANUAL_TRIPS], [SESSIONS]: s1.store.files[SESSIONS], [STATE]: s1.store.files[STATE] });
  const r2 = runRouter(s2.sandbox, s2.store, 'RETURN_TO_BASE', retPayload);
  assert(r2.indexOf('OK') === 0, 'same-second duplicate ids must be re-minted, not rejected: ' + r2);
  const s2Trips = JSON.parse(s2.store.files[MANUAL_TRIPS]);
  assert.strictEqual(Object.keys(s2Trips.trips).length, 2, 'both manual trips must exist after re-mint');
  const s1Trips = JSON.parse(s1.store.files[MANUAL_TRIPS]);
  const firstTripId = Object.keys(s1Trips.trips)[0];
  const secondTripId = Object.keys(s2Trips.trips).filter(function (id) { return id !== firstTripId; })[0];
  assert(firstTripId && secondTripId, 're-minted trip must have a distinct id');
  assert.notStrictEqual(secondTripId, firstTripId, 'second trip id must differ from the first');

  // Tasker-faithful propagation (verify run 3): the STAGED %par2 must carry
  // the re-minted ids, because in the serial task the reducer runs next from
  // the locals, not from the router's in-memory object. The mock's synchronous
  // reducer shim masks this; assert the staged bytes directly.
  const stagedPayload = JSON.parse(s2.sandbox.local('par2'));
  assert.notStrictEqual(stagedPayload.tripId, retPayload.tripId, 'staged par2 must carry the re-minted trip id');
  assert.strictEqual(stagedPayload.tripId, secondTripId, 'staged par2 trip id must match the session record id');
  assert.notStrictEqual(stagedPayload.actionId, retPayload.actionId, 'staged par2 must carry the re-minted action id');

  // Split-brain guard (verify run 2): the re-minted second trip must be
  // completable through RELEASE — reducer state, sessions, and manual trips
  // must all agree on the re-minted ids.
  const s2State = JSON.parse(s2.store.files[STATE]);
  const s2Sessions = JSON.parse(s2.store.files[SESSIONS]);
  const secondActionId = Object.keys(s2Sessions.sessions).filter(function (a) { return s2Sessions.sessions[a].tripId === secondTripId; })[0];
  assert(secondActionId, 're-minted trip must have a session');
  assert(s2State.trips[secondTripId], 're-minted trip must exist in reducer state');
  assert.strictEqual(s2State.trips[secondTripId].actionId, secondActionId, 'reducer trip must reference the re-minted action id');
  const s3 = make({ [MANUAL_TRIPS]: s2.store.files[MANUAL_TRIPS], [SESSIONS]: s2.store.files[SESSIONS], [STATE]: s2.store.files[STATE] });
  const r3 = runRouter(s3.sandbox, s3.store, 'RELEASE', { actionId: secondActionId, tripId: secondTripId, at: nowSec });
  assert(r3.indexOf('OK') === 0, 're-minted trip must release successfully: ' + r3);
  const s3Sessions = JSON.parse(s3.store.files[SESSIONS]);
  assert.strictEqual(s3Sessions.sessions[secondActionId].status, 'CLOSED', 're-minted session must close');

  const mint = make();
  const rm = runRouter(mint.sandbox, mint.store, 'SESSION_OPEN', { type: 'MANUAL_RETURN', at: nowSec,
    targetCoords: homeCoords, targetTitle: 'Return to Base', mode: 'DRIVE', durationSecs: 1800, distanceMiles: 3.1 });
  assert(rm.indexOf('OK') === 0, 'direct SESSION_OPEN must mint ids: ' + rm);
  const mintSessions = JSON.parse(mint.store.files[SESSIONS]);
  const mintedActionId = Object.keys(mintSessions.sessions)[0];
  const mintedTripId = mintSessions.sessions[mintedActionId].tripId;
  assert(/^action_[0-9a-z]+$/.test(mintedActionId) && /^manual_return_[0-9a-z]+$/.test(mintedTripId),
    'minted ids must follow the underscore + base-36 convention');
});

// ---------------------------------------------------------------------
// Section 4: two-file rollback (CRITICAL torn session commit).
// ---------------------------------------------------------------------
section('session-open-two-file-rollback', function () {
  const priorTrips = JSON.stringify({ schemaVersion: 1, trips: { old_1: { tripId: 'old_1', actionId: 'action_old' } } });
  const priorSessions = JSON.stringify({ schemaVersion: 1, sessions: { action_old: { actionId: 'action_old', status: 'ACTIVE' } } });
  const { sandbox, store } = make(
    { [MANUAL_TRIPS]: priorTrips, [SESSIONS]: priorSessions },
    {}, {},
    { failures: { tornWrites: ['TDS_Action_Sessions.json'] } }
  );
  const r = runRouter(sandbox, store, 'RETURN_TO_BASE', retPayload);
  assert(r.indexOf('ERROR') === 0, 'a torn second write must fail the open: ' + r);
  assert.strictEqual(store.files[MANUAL_TRIPS], priorTrips, 'trips file must be restored to exact prior bytes');
  assert.strictEqual(store.files[SESSIONS], priorSessions, 'sessions file must be restored to exact prior bytes');
  assert(!JSON.parse(store.files[MANUAL_TRIPS]).trips[TRIP_ID], 'no partial manual trip may remain');
});

section('session-open-first-write-torn', function () {
  const { sandbox, store } = make({}, {}, {}, { failures: { tornWrites: ['TDS_Manual_Trips.json'] } });
  const r = runRouter(sandbox, store, 'RETURN_TO_BASE', retPayload);
  assert(r.indexOf('ERROR') === 0, 'a torn first write must fail the open: ' + r);
  assert(!store.files[MANUAL_TRIPS], 'torn first write must leave no manual trips file');
  assert(!store.files[SESSIONS], 'a failed first write must not write the sessions file');
});

// REQ-4SESSION-1 fidelity: an EXISTING EMPTY file must be restored as
// present-empty on rollback, never deleted as if it were absent.
section('session-open-empty-file-rollback-fidelity', function () {
  // Seed an existing-but-empty sessions file: readFile must report it as
  // PRESENT (raw ""), so rollback restores presence, not deletion.
  const { sandbox, store } = make({}, {}, {}, { failures: { tornWrites: ['TDS_Action_Sessions.json'] } });
  store.files[SESSIONS] = '';
  const r = runRouter(sandbox, store, 'SESSION_OPEN', { type: 'MANUAL_RETURN', at: nowSec,
    targetCoords: homeCoords, targetTitle: 'Return to Base', mode: 'DRIVE', durationSecs: 1800, distanceMiles: 3.1 });
  assert(r.indexOf('ERROR') === 0, 'a torn sessions write must fail: ' + r);
  assert(store.files[SESSIONS] === '', 'an existing empty sessions file must be restored as present-empty, not deleted');
  assert(store.files[MANUAL_TRIPS] === undefined || store.files[MANUAL_TRIPS] === null, 'trips file must be absent after rollback of a fresh open');
});

// REQ-4SESSION-2: a legacy lock carrying a CONFLICTING present identifier
// must NOT be cleared by a release for a different action/trip.
section('session-release-conflicting-lock-preserved', function () {
  const sessions = { schemaVersion: 1, sessions: {
    action_a: { actionId: 'action_a', tripId: 't_a', status: 'ACTIVE' }
  } };
  const trips = { schemaVersion: 1, trips: {
    t_a: { tripId: 't_a', actionId: 'action_a', lifecycleState: 'IN_PROGRESS' }
  } };
  const conflictingLock = JSON.stringify({ type: 'MANUAL_ROUTING', actionId: 'action_OTHER', tripId: 't_a', timestamp: nowSec });
  const { sandbox, store } = make({ [SESSIONS]: JSON.stringify(sessions), [MANUAL_TRIPS]: JSON.stringify(trips), [LOCK]: conflictingLock });
  const r = runRouter(sandbox, store, 'RELEASE', { actionId: 'action_a', tripId: 't_a', at: nowSec });
  assert(r.indexOf('OK') === 0, 'release must be accepted: ' + r);
  assert.strictEqual(store.files[LOCK], conflictingLock, 'a lock with a conflicting present actionId must NOT be cleared');
  assert(!JSON.parse(store.files[LOCK] || '{}').actionId === undefined ? false : true, 'lock must still exist');

  const matchingLock = JSON.stringify({ type: 'MANUAL_ROUTING', actionId: 'action_a', tripId: 't_a', timestamp: nowSec });
  const { sandbox: s2, store: st2 } = make({ [SESSIONS]: JSON.stringify(sessions), [MANUAL_TRIPS]: JSON.stringify(trips), [LOCK]: matchingLock });
  const r2 = runRouter(s2, st2, 'RELEASE', { actionId: 'action_a', tripId: 't_a', at: nowSec });
  assert(r2.indexOf('OK') === 0, 'matching release must be accepted: ' + r2);
  assert.strictEqual(st2.files[LOCK], '{}', 'a lock matching all present identifiers must be cleared to empty');
  assert(parseLog(st2).some(function (l) { return l.code === 'LOCK_COMPATIBILITY_CLEARED'; }), 'LOCK_COMPATIBILITY_CLEARED must be logged');
});

// ---------------------------------------------------------------------
// Section 5: exact session/trip ownership (SCN-4SESSION-1).
// ---------------------------------------------------------------------
section('session-close-only-that-session', function () {
  const sessions = { schemaVersion: 1, sessions: {
    action_a: { actionId: 'action_a', tripId: 't_a', status: 'ACTIVE', closedAt: null },
    action_b: { actionId: 'action_b', tripId: 't_b', status: 'ACTIVE', closedAt: null }
  } };
  const { sandbox, store } = make({ [SESSIONS]: JSON.stringify(sessions) });
  const r = runRouter(sandbox, store, 'SESSION_CLOSE', { actionId: 'action_a', at: nowSec });
  assert(r.indexOf('OK') === 0, 'SESSION_CLOSE must be accepted: ' + r);
  const after = JSON.parse(store.files[SESSIONS]);
  assert.strictEqual(after.sessions.action_a.status, 'CLOSED', 'the named session must close');
  assert.strictEqual(after.sessions.action_a.closedAt, nowSec);
  assert.strictEqual(after.sessions.action_b.status, 'ACTIVE', 'only that session may close');
  const logs = parseLog(store);
  assert(logs.some(function (l) { return l.code === 'SESSION_CLOSED' && logFieldsOk(l); }), 'SESSION_CLOSED must be logged');

  const unknown = make({ [SESSIONS]: JSON.stringify(sessions) });
  const r2 = runRouter(unknown.sandbox, unknown.store, 'SESSION_CLOSE', { actionId: 'action_zz' });
  assert(r2.indexOf('ERROR') === 0, 'closing an unknown session must be rejected');
});

section('ownership-guards', function () {
  const { sandbox } = make();
  assert.throws(function () { sandbox.writeFile(SESSIONS, '{}'); }, /UNAUTHORIZED_WRITE_REJECTED/,
    'sessions may only be written by the Manual Action Handler');
  assert.throws(function () { sandbox.writeFile(MANUAL_TRIPS, '{}'); }, /UNAUTHORIZED_WRITE_REJECTED/,
    'manual trips may only be written by the Manual Action Handler');
  assert.throws(function () { sandbox.writeFile(LOCK, '{}'); }, /UNAUTHORIZED_WRITE_REJECTED/,
    'the legacy lock may only be cleared by the Manual Action Handler');
});

// ---------------------------------------------------------------------
// Section 6: completion, RELEASE and lock compatibility (REQ-4SESSION-2,
// SCN-4SESSION-2, MANUAL-13 tomorrow isolation).
// ---------------------------------------------------------------------
section('release-closes-exact-records-and-clears-lock', function () {
  const sessions = { schemaVersion: 1, sessions: { [ACTION_ID]: { actionId: ACTION_ID, tripId: TRIP_ID, status: 'ACTIVE', closedAt: null, closeReason: null } } };
  const trips = { schemaVersion: 1, trips: { [TRIP_ID]: { tripId: TRIP_ID, actionId: ACTION_ID, lifecycleState: 'IN_PROGRESS' } } };
  const lock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 60, eventId: TRIP_ID });
  const { sandbox, store } = make({ [SESSIONS]: JSON.stringify(sessions), [MANUAL_TRIPS]: JSON.stringify(trips), [LOCK]: lock });
  const r = runRouter(sandbox, store, 'RELEASE', { actionId: ACTION_ID, tripId: TRIP_ID, at: nowSec });
  assert(r.indexOf('OK') === 0, 'RELEASE must be accepted: ' + r);
  const afterSessions = JSON.parse(store.files[SESSIONS]);
  assert.strictEqual(afterSessions.sessions[ACTION_ID].status, 'CLOSED', 'RELEASE must close the exact session');
  assert.strictEqual(afterSessions.sessions[ACTION_ID].closeReason, 'COMPLETED');
  const afterTrips = JSON.parse(store.files[MANUAL_TRIPS]);
  assert.strictEqual(afterTrips.trips[TRIP_ID].lifecycleState, 'COMPLETED', 'RELEASE must complete the exact manual trip');
  assert.strictEqual(store.files[LOCK], '{}', 'RELEASE must clear the matching legacy lock');
  const logs = parseLog(store);
  const cleared = logs.find(function (l) { return l.code === 'LOCK_COMPATIBILITY_CLEARED'; });
  assert(cleared && logFieldsOk(cleared), 'LOCK_COMPATIBILITY_CLEARED must be logged with all LOG-17 fields');
});

section('release-mismatch-and-nonmatching-lock', function () {
  const sessions = { schemaVersion: 1, sessions: { [ACTION_ID]: { actionId: ACTION_ID, tripId: TRIP_ID, status: 'ACTIVE' } } };
  const trips = { schemaVersion: 1, trips: { [TRIP_ID]: { tripId: TRIP_ID, actionId: ACTION_ID, lifecycleState: 'IN_PROGRESS' } } };
  const lock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 60, eventId: 'some_other_trip' });
  const { sandbox, store } = make({ [SESSIONS]: JSON.stringify(sessions), [MANUAL_TRIPS]: JSON.stringify(trips), [LOCK]: lock });
  const r = runRouter(sandbox, store, 'RELEASE', { actionId: ACTION_ID, tripId: 'unrelated_trip', at: nowSec });
  assert(r.indexOf('ERROR') === 0, 'a mismatched actionId/tripId pair must be rejected');
  assert.strictEqual(store.files[LOCK], lock, 'a failed RELEASE must not clear the lock');

  const { sandbox: s2, store: st2 } = make({ [SESSIONS]: JSON.stringify(sessions), [MANUAL_TRIPS]: JSON.stringify(trips), [LOCK]: lock });
  const r2 = runRouter(s2, st2, 'RELEASE', { actionId: ACTION_ID, tripId: TRIP_ID, at: nowSec });
  assert.strictEqual(r2.indexOf('OK'), 0, 'matching RELEASE must be accepted: ' + r2);
  assert.strictEqual(st2.files[LOCK], lock, 'a non-matching legacy lock must survive RELEASE');
  const logs = parseLog(st2);
  assert(!logs.some(function (l) { return l.code === 'LOCK_COMPATIBILITY_CLEARED'; }), 'non-matching lock must not be cleared');
});

section('completion-leaves-tomorrow-planned', function () {
  const trips = {
    today_ret: { tripId: 'today_ret', actionId: ACTION_ID, legType: 'MANUAL_RETURN', lifecycleState: 'IN_PROGRESS',
      departures: [{ at: nowSec - 1800, planningDay: todayDay }], currentPlanningDay: todayDay },
    tomorrow_trip: { tripId: 'tomorrow_trip', lifecycleState: 'PLANNED', departures: [], currentPlanningDay: tomorrowDay }
  };
  const before = JSON.parse(seededState(trips));
  const { sandbox, store } = make({ [STATE]: seededState(trips) });
  const r = runRouter(sandbox, store, 'COMPLETE_TRIP', { generationId: GEN_ID, tripId: 'today_ret', at: nowSec, planningDay: todayDay });
  assert.strictEqual(r, 'OK', 'COMPLETE_TRIP must be accepted');
  const state = JSON.parse(store.files[STATE]);
  assert.strictEqual(state.trips.today_ret.lifecycleState, 'COMPLETED', 'today manual return must complete');
  assert.deepStrictEqual(state.trips.tomorrow_trip, before.trips.tomorrow_trip,
    'tomorrow trip must stay byte-identical PLANNED after completion');
});

section('unlock-cannot-clear-lock', function () {
  // The lock is migration-only and handler-clearable: the legacy Unlock
  // script must no longer be able to clear it (REQ-4SESSION-2).
  const completedState = JSON.parse(seededState({}));
  completedState.manualReturnCompleted = true;
  const staleLock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 10000, eventId: 'today_ret' });
  const { sandbox, store } = make({ [LOCK]: staleLock, [STATE]: JSON.stringify(completedState) });
  runScript(UNLOCK, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  assert.strictEqual(store.files[LOCK], staleLock, 'Unlock must not clear the lock (handler-only)');
});

// ---------------------------------------------------------------------
// Section 7: session-primary reads (REQ-4SESSION-2).
// ---------------------------------------------------------------------
const dispatcherGlobals = {
  Tesla_Last_Scheduled: '0', Tesla_Last_HVAC_Unix: '0', Tesla_Last_Nav: '',
  Google_Last_Nav: '', Current_Status: '', User_At_AdHoc: '', TDS_Active_Generation: GEN_ID
};
const dispatcherItin = JSON.stringify([{
  tripId: 'today_trip', targetEventId: 'ev_today_kx8f00', mode: 'DRIVE',
  departUnix: nowSec + 5400, arriveUnix: nowSec + 7200, targetTitle: 'Work',
  targetCoords: awayCoords, planningDay: todayDay
}]);

function nextSyncStr(nowMs, mins) {
  const d = new Date(nowMs + mins * 60000);
  return (d.getHours() < 10 ? '0' : '') + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}

section('dispatcher-session-primary-lock', function () {
  // (a) Active session -> heartbeat locked (+120 min sync).
  const activeSessions = { schemaVersion: 1, sessions: { [ACTION_ID]: { actionId: ACTION_ID, status: 'ACTIVE', expiresAt: nowSec + 3600 } } };
  const { sandbox: s1, store: st1 } = make({ [DATA + 'Itin_Master.json']: dispatcherItin, [SESSIONS]: JSON.stringify(activeSessions) }, dispatcherGlobals);
  runScript(DISPATCHER, s1, st1);
  if (st1.runError) throw new Error(st1.runError.message);
  assert.strictEqual(s1.global('Next_Sync'), nextSyncStr(nowSec * 1000, 120), 'active session must lock the heartbeat to 120 min');

  // (b) Readable EMPTY session map + unexpired legacy lock -> unlocked (sessions authoritative).
  const emptySessions = { schemaVersion: 1, sessions: {} };
  const freshLock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 60, eventId: 'x' });
  const { sandbox: s2, store: st2 } = make(
    { [DATA + 'Itin_Master.json']: dispatcherItin, [SESSIONS]: JSON.stringify(emptySessions), [LOCK]: freshLock }, dispatcherGlobals);
  runScript(DISPATCHER, s2, st2);
  if (st2.runError) throw new Error(st2.runError.message);
  assert.strictEqual(s2.local('itin_mode1'), 'DRIVE', 'an empty session map must mean unlocked despite a legacy lock');
  assert.strictEqual(s2.global('Next_Sync'), nextSyncStr(nowSec * 1000, 60), 'unlocked dispatcher must use the trip sync bucket');

  // (c) Sessions absent -> legacy lock honoured (fallback).
  const { sandbox: s3, store: st3 } = make({ [DATA + 'Itin_Master.json']: dispatcherItin, [LOCK]: freshLock }, dispatcherGlobals);
  runScript(DISPATCHER, s3, st3);
  if (st3.runError) throw new Error(st3.runError.message);
  assert.strictEqual(s3.global('Next_Sync'), nextSyncStr(nowSec * 1000, 120), 'absent sessions must fall back to the legacy lock');
});

const compilerLocals = {
  block_queue: makeEnvelope([makeTypedRow({
    rowType: 'EVENT', title: 'Future Event', coords: awayCoords, mode: 'DRIVE',
    displayTime: nowSec + 3600, departTime: nowSec + 3600, pitstopState: 'false',
    apiTimeType: 'DEPART', apiTimeUnix: nowSec + 3600, evId: 'ev_x_kx8f00',
    evLoc: 'Office', engineLateMins: 0, currentLegStable: false,
    dropinStatusFlag: 'none', safeDesc: '', adHoc: [],
    departurePolicy: 'JIT', planningDay: todayDay, originSource: 'LIVE_BASE'
  })]),
  api_duration_secs: '1800', api_distance_miles: '15', api_transit_steps: '', virtual_time: String(nowSec - 60)
};
const compilerFiles = {
  [DATA + 'TDS_Master.json']: JSON.stringify([{ id: 'ev_x_kx8f00', start: nowSec + 3600, end: nowSec + 7200, duration: 3600, title: 'Work', desc: '', loc: 'Office', coords: awayCoords }]),
  [DATA + 'Itin_Master.json']: JSON.stringify([{ tripId: 'stale_leg', targetEventId: 'prev_kx8f00', mode: 'DRIVE', departUnix: nowSec - 3600, arriveUnix: nowSec - 1800 }]),
  [DATA + 'TDS_Overrides.json']: '{}'
};

function runCompiler(files, globals) {
  const { sandbox, store } = make(Object.assign({}, compilerFiles, files || {}),
    Object.assign({ User_At_Base: 'true', User_Loc: homeCoords, Arrival_Buffer_Mins: '5', Departure_Buffer_Mins: '5' }, globals || {}),
    compilerLocals);
  runScript(COMPILER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  return store;
}

section('compiler-session-primary-gate', function () {
  // Control (no sessions, no lock): the candidate publishes.
  const control = runCompiler();
  assert(control.files[DATA + 'TDS_Run_Manifest.json'], 'control compiler run must publish a committed generation');

  // Active session: the heartbeat build is suppressed (no publish).
  const activeSessions = { schemaVersion: 1, sessions: { [ACTION_ID]: { actionId: ACTION_ID, status: 'ACTIVE', expiresAt: nowSec + 3600 } } };
  const suppressed = runCompiler({ [SESSIONS]: JSON.stringify(activeSessions) });
  assert(!suppressed.files[DATA + 'TDS_Run_Manifest.json'], 'an active session must suppress the heartbeat candidate');

  // Readable EMPTY session map + unexpired legacy lock: unlocked -> publishes.
  const emptySessions = { schemaVersion: 1, sessions: {} };
  const freshLock = JSON.stringify({ type: 'MANUAL_ROUTING', timestamp: nowSec - 60, eventId: 'x' });
  const authoritative = runCompiler({ [SESSIONS]: JSON.stringify(emptySessions), [LOCK]: freshLock });
  assert(authoritative.files[DATA + 'TDS_Run_Manifest.json'], 'an empty session map must be authoritative: candidate publishes');

  // Sessions absent + unexpired lock: legacy fallback -> suppressed.
  const fallback = runCompiler({ [LOCK]: freshLock });
  assert(!fallback.files[DATA + 'TDS_Run_Manifest.json'], 'absent sessions must fall back to the legacy lock (suppressed)');
});

// ---------------------------------------------------------------------
try {
  console.log('Manual session Slice B regression suite:');
  if (failures.length > 0) {
    console.log('FAILED SECTIONS: ' + failures.length);
    console.log('FAIL: manual-session — ' + failures[0]);
    process.exit(1);
  }
  console.log('PASS: manual-session — typed depart/return, sessions, ownership, rollback, lock compatibility');
  process.exit(0);
} catch (e) {
  console.log('FAIL: manual-session — ' + e.message);
  process.exit(1);
}
