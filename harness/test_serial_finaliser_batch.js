// REQ-6F2-1..4 (SCN-6F2-2/3/4/5/6/7, SCN-6FU-12): serial-mode proof that a
// Finaliser pass staging COMPLETE_DROPIN then OBSERVE_ARRIVAL delivers BOTH
// observations to the Trip State Reducer in one REDUCER_BATCH, with the
// publish candidate primary-last.
//
// The serial Tasker model delivers only the LAST staged par1/par2 per pass to
// TDS_State_Command. Today the Finaliser stages raw par1/par2 for
// COMPLETE_DROPIN then OBSERVE_ARRIVAL; the first observation is clobbered
// before the reducer sees it, and publishCandidate re-stages par1 as the
// candidate. The synchronous reducer() shim used by the other suites masks
// the loss — serialMode (no shims) exposes it.
//
// RED baseline: pre-fix the pass stages no observation batch, so after the
// Generation_Publisher run the staged par1 is plain RECONCILE_GENERATION and
// the first envelope assertion fails with the last-wins clobber. GREEN: the
// Finaliser accumulates into tds_obs_batch_par1/par2, the Publisher merges
// [RECONCILE_GENERATION, ...obs] with re-stamped generationIds, and one
// router invocation delivers every sub-command in order.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;                    // 2023-11-14T22:13:20Z
const DATA = 'Tasker/Tesla/Data/';
const STATE = DATA + 'TDS_Trip_State.json';
const MANIFEST = DATA + 'TDS_Run_Manifest.json';
const GEN_ID = 'gen:1700000000:ab12';
const homeCoords = '51.9,-2.1';
const prevCoords = '52.1,-2.2';               // dropin site (TDS_Previous_Loc)
const DROPIN_ID = 'abc123_dropin';
const ARRIVAL_ID = 'abc123_arrival';

const FINALISER = path.resolve(__dirname, '..', 'Finaliser.js');
const PUBLISHER = path.resolve(__dirname, '..', 'Generation_Publisher.js');

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

function commonFiles() {
  return {
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}'
  };
}

// Dropin that qualifies for COMPLETE_DROPIN: previous location at the event
// (dPrev ~ 0), current location away (dCurr >> 200m), event inside the 12h
// geofence window on the same UTC day.
function dropinEvent() {
  return {
    id: DROPIN_ID, start: nowSec - 3600, end: nowSec + 3600,
    title: 'Dropin', loc: 'Near', coords: prevCoords, isDropin: true
  };
}

// Arrival that qualifies for OBSERVE_ARRIVAL: current location at the event
// (dCurr ~ 0), previous location away so no completion branch fires.
function arrivalEvent(id) {
  return {
    id: id, start: nowSec - 3600, end: nowSec + 3600,
    title: 'Arrival', loc: 'Here', coords: homeCoords, isDropin: false
  };
}

function finaliserGlobals(extra) {
  return Object.assign({
    User_Loc: homeCoords,
    User_At_Base: 'true',
    TDS_Previous_Loc: prevCoords,
    TDS_Active_Generation: GEN_ID
  }, extra || {});
}

// Run the Generation Publisher exactly like the serial Tasker task: the next
// action reads local('par1') (the staged candidate) and runs the publisher.
function runPublisher(sandbox, store) {
  sandbox.__currentScriptPath = PUBLISHER;
  runScript(PUBLISHER, sandbox, store);
  sandbox.__currentScriptPath = '';
  if (store.runError) throw new Error(store.runError.message);
  return sandbox.local('return_value');
}

function activeGeneration(store) {
  const m = JSON.parse(store.files[MANIFEST]);
  return m.activeGeneration;
}

// SCN-6F2-7 / SCN-6FU-12: one pass staging COMPLETE_DROPIN then
// OBSERVE_ARRIVAL then the candidate; the observations must be staged into
// the dedicated accumulator local with the candidate primary-last.
section('finaliser-pass-stages-observation-batch-and-candidate', function () {
  const files = Object.assign({}, commonFiles(), {
    [STATE]: seededState({})
  });
  const { sandbox, store } = make(files, finaliserGlobals(), { tds_temp_json: JSON.stringify([dropinEvent(), arrivalEvent(ARRIVAL_ID)]) });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  // Candidate primary-last: par1 must be the publish candidate JSON, never a
  // staged observation command (REQ-6F2-1).
  const candidateRaw = store.locals.par1;
  assert.notStrictEqual(candidateRaw, 'COMPLETE_DROPIN', 'par1 must not be the COMPLETE_DROPIN staging token');
  assert.notStrictEqual(candidateRaw, 'OBSERVE_ARRIVAL', 'par1 must not be the OBSERVE_ARRIVAL staging token');
  const candidate = JSON.parse(candidateRaw);
  assert(Array.isArray(candidate.events), 'par1 must carry the publish candidate');

  // The observations must be staged into the dedicated accumulator local.
  assert.strictEqual(store.locals['tds_obs_batch_par1'], 'OBSERVATION_BATCH',
    'tds_obs_batch_par1 must carry the OBSERVATION_BATCH sentinel');
  const staged = JSON.parse(store.locals['tds_obs_batch_par2']);
  assert.deepStrictEqual(staged.map(function (o) { return o.command; }),
    ['COMPLETE_DROPIN', 'OBSERVE_ARRIVAL'],
    'observation batch must preserve staging order');
});

// SCN-6F2-4: the Publisher serial branch merges the staged observations into
// one REDUCER_BATCH — [RECONCILE_GENERATION, ...obs] with each observation
// generationId re-stamped to the freshly published genId.
section('publisher-merges-observations-into-reducer-batch', function () {
  const files = Object.assign({}, commonFiles(), {
    [STATE]: seededState({})
  });
  const { sandbox, store } = make(files, finaliserGlobals(), { tds_temp_json: JSON.stringify([dropinEvent(), arrivalEvent(ARRIVAL_ID)]) });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  runPublisher(sandbox, store);

  // ONE serial REDUCER_BATCH envelope, not a last-wins observation command and
  // not the plain reconcile (RED baseline: par1 is RECONCILE_GENERATION).
  assert.strictEqual(store.locals.par1, 'REDUCER_BATCH',
    'staged par1 must be REDUCER_BATCH (last-wins pre-fix: got ' + store.locals.par1 + ')');
  const envelope = JSON.parse(store.locals.par2);
  const genId = activeGeneration(store);
  assert.strictEqual(envelope.generationId, genId, 'batch envelope must carry the freshly published generation');
  assert.deepStrictEqual(envelope.commands.map(function (c) { return c.command; }),
    ['RECONCILE_GENERATION', 'COMPLETE_DROPIN', 'OBSERVE_ARRIVAL'],
    'merged batch must be [RECONCILE_GENERATION, ...observations] in staging order');
  assert.deepStrictEqual(envelope.commands[0].payload,
    { generationId: genId, activeGeneration: genId, manifestSchemaVersion: 2 },
    'reconcile entry must match the plain serial staging payload');
  assert.strictEqual(envelope.commands[1].payload.generationId, genId,
    'COMPLETE_DROPIN generationId must be re-stamped to the new genId');
  assert.strictEqual(envelope.commands[2].payload.generationId, genId,
    'OBSERVE_ARRIVAL generationId must be re-stamped to the new genId');

  // The accumulator locals are consumed by the publisher.
  assert.strictEqual(store.locals['tds_obs_batch_par1'], '', 'publisher must clear tds_obs_batch_par1');
  assert.strictEqual(store.locals['tds_obs_batch_par2'], '', 'publisher must clear tds_obs_batch_par2');

  const logs = parseLog(store);
  const merged = logs.find(function (l) { return l.code === 'OBS_BATCH_MERGED'; });
  assert(merged, 'publisher must log OBS_BATCH_MERGED');
  assert.strictEqual(merged.details.count, 2, 'OBS_BATCH_MERGED must report the observation count');
});

// SCN-6F2-7: one router invocation delivers every sub-command in event order —
// both observations commit and the reconcile aligns state to the new genId.
section('one-router-invocation-delivers-both-observations', function () {
  const files = Object.assign({}, commonFiles(), {
    [STATE]: seededState({})
  });
  const { sandbox, store } = make(files, finaliserGlobals(), { tds_temp_json: JSON.stringify([dropinEvent(), arrivalEvent(ARRIVAL_ID)]) });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  runPublisher(sandbox, store);

  const envelope = JSON.parse(store.locals.par2);
  const rv = sandbox.stateCommand('REDUCER_BATCH', envelope);
  assert.strictEqual(rv, 'OK', 'REDUCER_BATCH must be accepted by the router: ' + rv);

  const state = JSON.parse(store.files[STATE]);
  assert(state.completedDropins && state.completedDropins[DROPIN_ID],
    'COMPLETE_DROPIN must commit the dropin completion');
  assert.strictEqual(state.completedDropins[DROPIN_ID].completedUnix, nowSec,
    'COMPLETE_DROPIN must record the Finaliser completion time');
  assert(state.trips[ARRIVAL_ID], 'OBSERVE_ARRIVAL must record the arrival trip');
  assert.strictEqual(state.trips[ARRIVAL_ID].observedArrivalUnix, nowSec,
    'OBSERVE_ARRIVAL must record the arrival time');
  assert.strictEqual(state.trips[ARRIVAL_ID].observedArrivalAccuracyM, 150,
    'OBSERVE_ARRIVAL must carry the accuracy observation');
  assert.strictEqual(state.currentGeneration, activeGeneration(store),
    'RECONCILE_GENERATION must align reducer state to the published generation');

  const logs = parseLog(store);
  const delivered = logs.find(function (l) { return l.code === 'REDUCER_BATCH_DELIVERED'; });
  assert(delivered, 'reducer must log REDUCER_BATCH_DELIVERED');
  assert.strictEqual(delivered.details.count, 3, 'REDUCER_BATCH_DELIVERED must report the command count');
  assert.strictEqual(delivered.details.applied, 3, 'every sub-command must apply');
  assert.strictEqual(delivered.details.skipped, 0, 'no sub-command may be skipped');
  const rejected = logs.find(function (l) { return l.code === 'BATCH_ENVELOPE_REJECTED'; });
  assert(!rejected, 'no BATCH_ENVELOPE_REJECTED may be logged');
});

// SCN-6F2-5: a no-observation pass stages plain RECONCILE_GENERATION
// byte-identical to the pre-change serial behavior.
section('no-obs-pass-stages-plain-reconcile', function () {
  const files = Object.assign({}, commonFiles(), {
    [STATE]: seededState({})
  });
  const { sandbox, store } = make(files, finaliserGlobals(), { tds_temp_json: '[]' });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  runPublisher(sandbox, store);

  const genId = activeGeneration(store);
  assert.strictEqual(store.locals.par1, 'RECONCILE_GENERATION',
    'no-obs pass must stage plain RECONCILE_GENERATION');
  assert.strictEqual(store.locals.par2, JSON.stringify({ generationId: genId, activeGeneration: genId, manifestSchemaVersion: 2 }),
    'no-obs pass must stage the reconcile payload byte-identical');
  assert.strictEqual(store.locals['tds_obs_batch_par1'], '', 'no-obs pass must consume the accumulator locals');
  assert.strictEqual(store.locals['tds_obs_batch_par2'], '', 'no-obs pass must consume the accumulator locals');
  const logs = parseLog(store);
  assert(!logs.some(function (l) { return l.code === 'OBS_BATCH_MERGED'; }), 'no-obs pass must not log OBS_BATCH_MERGED');
  assert(!logs.some(function (l) { return l.code === 'BATCH_ENVELOPE_REJECTED'; }), 'no-obs pass must not log BATCH_ENVELOPE_REJECTED');
});

// SCN-6F2-3 (REQ-6F2-2): the fallback generationId fails STATE_CMD_GEN_REGEX,
// so the observation is flush-skipped (logged with its tripId) and never
// staged; the publisher then stages plain RECONCILE_GENERATION — the device
// never sees an envelope that would fail the pre-check.
section('invalid-generation-flush-skips-observation', function () {
  const files = Object.assign({}, commonFiles(), {
    [STATE]: seededState({})
  });
  const { sandbox, store } = make(files, finaliserGlobals({ TDS_Active_Generation: '' }),
    { tds_temp_json: JSON.stringify([dropinEvent()]) });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  const logs = parseLog(store);
  const skipped = logs.filter(function (l) { return l.code === 'OBS_BATCH_FLUSH_SKIPPED'; });
  assert(skipped.length === 1, 'invalid-generation observation must be flush-skipped once, got ' + skipped.length);
  assert.strictEqual(skipped[0].tripId, DROPIN_ID, 'OBS_BATCH_FLUSH_SKIPPED must carry the per-observation tripId');
  assert.strictEqual(skipped[0].details.command, 'COMPLETE_DROPIN', 'OBS_BATCH_FLUSH_SKIPPED must name the command');

  // Nothing staged: no accumulator locals, and the publisher falls back to
  // the plain reconcile — no envelope reaches TDS_State_Command for the obs.
  assert(!store.locals['tds_obs_batch_par1'],
    'flush-skipped pass must not stage the observation batch');
  assert(!store.locals['tds_obs_batch_par2'],
    'flush-skipped pass must not stage observation payloads');
  runPublisher(sandbox, store);
  const genId = activeGeneration(store);
  assert.strictEqual(store.locals.par1, 'RECONCILE_GENERATION',
    'flush-skipped pass must fall back to plain RECONCILE_GENERATION');
  assert.strictEqual(store.locals.par2, JSON.stringify({ generationId: genId, activeGeneration: genId, manifestSchemaVersion: 2 }),
    'flush-skipped pass must not carry any observation envelope');
  const postLogs = parseLog(store);
  assert(!postLogs.some(function (l) { return l.code === 'BATCH_ENVELOPE_REJECTED'; }),
    'flush-skipped pass must never produce BATCH_ENVELOPE_REJECTED');
});

// SCN-6F2-6: a burst beyond the 31-obs cap keeps the first 31 (one slot
// reserved for RECONCILE_GENERATION) and drops the excess with a structured
// log — all-or-nothing loss is forbidden.
section('burst-over-cap-keeps-first-31-and-logs-truncation', function () {
  const arrivals = [];
  for (let i = 0; i < 33; i++) arrivals.push(arrivalEvent('abc123_burst' + i));
  const events = [dropinEvent()].concat(arrivals);
  const files = Object.assign({}, commonFiles(), {
    [STATE]: seededState({})
  });
  const { sandbox, store } = make(files, finaliserGlobals(), { tds_temp_json: JSON.stringify(events) });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  runPublisher(sandbox, store);

  assert.strictEqual(store.locals.par1, 'REDUCER_BATCH', 'burst pass must still stage one REDUCER_BATCH');
  const envelope = JSON.parse(store.locals.par2);
  assert.strictEqual(envelope.commands.length, 32,
    'envelope must total MAX_REDUCER_BATCH_SIZE (32) = reconcile + 31 observations');
  assert.strictEqual(envelope.commands[0].command, 'RECONCILE_GENERATION',
    'reconcile must lead the capped envelope');
  assert.deepStrictEqual(envelope.commands.slice(1, 3).map(function (c) { return c.command; }),
    ['COMPLETE_DROPIN', 'OBSERVE_ARRIVAL'],
    'kept observations must preserve staging order (dropin first, then arrivals)');
  assert.strictEqual(envelope.commands[31].command, 'OBSERVE_ARRIVAL',
    'the 31st kept observation must be the last arrival kept');
  const logs = parseLog(store);
  const truncated = logs.find(function (l) { return l.code === 'OBS_BATCH_TRUNCATED'; });
  assert(truncated, 'publisher must log OBS_BATCH_TRUNCATED for the excess');
  assert.strictEqual(truncated.details.dropped, 3, 'OBS_BATCH_TRUNCATED must report the dropped count');

  // The capped envelope must still be accepted and fully applied.
  const rv = sandbox.stateCommand('REDUCER_BATCH', envelope);
  assert.strictEqual(rv, 'OK', 'capped REDUCER_BATCH must be accepted: ' + rv);
  const postLogs = parseLog(store);
  const delivered = postLogs.find(function (l) { return l.code === 'REDUCER_BATCH_DELIVERED'; });
  assert(delivered, 'reducer must log REDUCER_BATCH_DELIVERED for the capped batch');
  assert.strictEqual(delivered.details.count, 32, 'delivery count must match the envelope');
  assert.strictEqual(delivered.details.applied, 32, 'every capped sub-command must apply');
  assert.strictEqual(delivered.details.skipped, 0, 'no capped sub-command may be skipped');
});

// ---------------------------------------------------------------------
try {
  console.log('Serial Finaliser batch regression suite:');
  if (failures.length > 0) {
    console.log('FAILED SECTIONS: ' + failures.length);
    console.log('FAIL: serial-finaliser-batch — ' + failures[0]);
    process.exit(1);
  }
  console.log('PASS: serial-finaliser-batch — COMPLETE_DROPIN and OBSERVE_ARRIVAL deliver in one REDUCER_BATCH, candidate primary-last');
  process.exit(0);
} catch (e) {
  console.log('FAIL: serial-finaliser-batch — ' + e.message);
  process.exit(1);
}
