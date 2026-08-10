// Dispatcher multi-stop payload order — the Bolt nav plugin contract.
//
// The Bolt plugin hands the staged stop list to the car in REVERSE
// navigation order, so the Dispatcher emits the sequential-stop payload
// chronologically reversed: tds_next_coords = "lastStop~...~firstStop"
// (destination last). This locks that contract: a 3-stop chain must stage
// C~B~A, a broken chain (overnight boundary) stays a single destination,
// and the reverse must never reorder a single-coords payload.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000; // 2023-11-14T22:13:20Z
const DATA = 'Tasker/Tesla/Data/';
const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');

const aCoords = '51.9,-2.1';
const bCoords = '52.0,-2.0';
const cCoords = '52.1,-2.3';

function make(master, extraGlobals, stateFile) {
  const globals = Object.assign({
    Tesla_Last_Scheduled: '0', Tesla_Last_HVAC_Unix: '0', Tesla_Last_Nav: '',
    Google_Last_Nav: '', Current_Status: '', User_At_AdHoc: '',
    TDS_Active_Generation: 'gen:1700000000:ab12'
  }, extraGlobals || {});
  const { sandbox, store } = createSandbox({
    globals: globals,
    files: { [DATA + 'Itin_Master.json']: JSON.stringify(master), [DATA + 'TDS_Trip_State.json']: stateFile || '{}' },
    nowMs: nowSec * 1000
  });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error('Dispatcher crashed: ' + store.runError.message);
  return store;
}

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: dispatcher-multi-stop — ' + msg); }

function leg(id, coords, departSec, arriveSec, desc, mode) {
  return {
    tripId: 'trip_' + id, targetEventId: id, targetTitle: 'Stop ' + id, targetCoords: coords,
    targetDesc: desc || '', mode: mode || 'DRIVE',
    departUnix: departSec, arriveUnix: arriveSec, durationSecs: 1800
  };
}

// SCN-1: 3-stop chain, all departures on the target's local day -> payload
// reversed (C~B~A), nav push granted. Leg2 departs 23:58 day 14 (chain stays
// on the planning day; its ARRIVAL may cross midnight — the chain anchor is
// the departure day, mirroring FUTURE_TRIP_NOT_DUE).
try {
  // leg0 target: depart 22:43, arrive 23:13; leg1: depart 23:28 (15m stay),
  // arrive 23:58; leg2: depart 23:58 (0m stay), arrive 00:28 day 15.
  const master = [
    leg('leg0', aCoords, nowSec + 1800, nowSec + 3600, '#dropin'),
    leg('leg1', bCoords, nowSec + 4500, nowSec + 6300, '#dropin'),
    leg('leg2', cCoords, nowSec + 6300, nowSec + 8100, '#dropin')
  ];
  const store = make(master);
  const payload = store.locals['tds_next_coords'];
  assert.strictEqual(payload, cCoords + '~' + bCoords + '~' + aCoords,
    'multi-stop payload must be chronologically REVERSED (last stop first), got: ' + payload);
} catch (e) { fail('reversed 3-stop chain: ' + e.message); }

// SCN-4: midnight-straddling SHORT stop keeps the chain (gate = stop length,
// not clock time) — a 10-min stop arriving 23:50 day 14 and departing 00:01
// day 15 sequences the next stop into the same payload.
try {
  // leg0 arrives 23:50 (day 14); leg1 (plain stop, NOT dropin) departs 00:01
  // day 15 — stay 10 min ≤ SHORT_STAY_MINS, so the length gate chains it.
  const master = [
    leg('leg0', aCoords, nowSec + 3600, nowSec + 5860),
    leg('leg1', bCoords, nowSec + 6460, nowSec + 8260)
  ];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], bCoords + '~' + aCoords,
    'a short stop straddling midnight must keep the chain (length gate), got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('midnight-straddling short stop: ' + e.message); }

// SCN-5: a LONG dwell breaks the chain even when the previous stop is a
// dropin — a 6h17m dwell between stops never sequences into one payload.
try {
  // leg0 dropin departs 23:13, arrives 23:43 (day 14); leg1 dropin departs
  // 06:00 (day 15) — 6h17m dwell > SHORT_STAY_MINS.
  const master = [
    leg('leg0', aCoords, nowSec + 3600, nowSec + 5400, '#dropin'),
    leg('leg1', bCoords, nowSec + 27800, nowSec + 29600, '#dropin')
  ];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'a long dwell (> SHORT_STAY_MINS) must break the chain, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('long-dwell chain break: ' + e.message); }

// SCN-8: a DROPIN with a long dwell gets NO carve-out — it is its own trip
// and never sequences with the next stop (dropins chain only when the dwell
// before the next stop is short).
try {
  // leg0 dropin departs 22:00, arrives 22:00; leg1 dropin departs 23:30
  // (90-min dwell > SHORT_STAY_MINS) — must NOT chain.
  const master = [
    leg('leg0', aCoords, nowSec + 600, nowSec + 600, '#dropin'),
    leg('leg1', bCoords, nowSec + 6000, nowSec + 7800, '#dropin')
  ];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'a dropin with a long dwell must not sequence the next stop, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('dropin long-dwell no carve-out: ' + e.message); }

// SCN-2: broken chain (next stop is a >5h overnight gap) -> single coords.
try {
  const master = [
    leg('leg0', aCoords, nowSec + 1800, nowSec + 3600, '#dropin'),
    leg('leg1', bCoords, nowSec + 86400 + 1800, nowSec + 86400 + 3600, '#dropin')
  ];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'overnight boundary must break the chain to a single destination, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('broken-chain single coords: ' + e.message); }

// SCN-3: single destination (no multi-stop branch) -> payload unchanged.
try {
  const master = [leg('leg0', aCoords, nowSec + 1800, nowSec + 3600)];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'single destination payload must be unchanged, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('single destination: ' + e.message); }

// SCN-6: nav re-push dedup — a SHRUNK chain (tail stop cancelled between
// syncs) must re-stage the payload. The committed payload is reversed
// (C~B~A); the new plan drops stop C, so the new payload (B~A) is a SUFFIX
// of the committed one — the old suffix dedup suppressed the push and the
// car kept driving the cancelled stop. Equality-only dedup must re-push.
try {
  const master = [
    leg('leg0', aCoords, nowSec + 1800, nowSec + 3600, '#dropin'),
    leg('leg1', bCoords, nowSec + 4500, nowSec + 6300, '#dropin')
  ];
  const store = make(master, { Tesla_Last_Nav: cCoords + '~' + bCoords + '~' + aCoords });
  assert.strictEqual(store.locals['tds_next_coords'], bCoords + '~' + aCoords,
    'shrunk chain payload, got: ' + store.locals['tds_next_coords']);
  assert.strictEqual(store.locals['do_tesla_nav'], 'true',
    'a shrunk chain must re-push the nav payload (cancelled stop must not keep driving), got: ' + store.locals['do_tesla_nav']);
} catch (e) { fail('shrunk-chain re-push: ' + e.message); }

// SCN-7: an EQUAL payload (same stops, same order) suppresses the re-push.
try {
  const master = [
    leg('leg0', aCoords, nowSec + 1800, nowSec + 3600, '#dropin'),
    leg('leg1', bCoords, nowSec + 4500, nowSec + 6300, '#dropin'),
    leg('leg2', cCoords, nowSec + 6300, nowSec + 8100, '#dropin')
  ];
  const store = make(master, { Tesla_Last_Nav: cCoords + '~' + bCoords + '~' + aCoords });
  assert.strictEqual(store.locals['tds_next_coords'], cCoords + '~' + bCoords + '~' + aCoords,
    'identical chain payload, got: ' + store.locals['tds_next_coords']);
  assert.strictEqual(store.locals['do_tesla_nav'], 'false',
    'an identical payload must suppress the re-push, got: ' + store.locals['do_tesla_nav']);
} catch (e) { fail('identical-payload suppression: ' + e.message); }

// SCN-9: a COMPLETED trip (observedArrivalUnix in reducer state, still inside
// its relevance window) is never re-routed — the Dispatcher excludes it
// (COMPLETED_TRIP_SKIPPED) instead of selecting it as overdue-within-window.
try {
  // leg0 departed 40 min ago, arrives 10 min ago — within the arrival+grace
  // relevance window, so without completion state it WOULD be bestOverdue.
  const master = [
    leg('leg0', aCoords, nowSec - 2400, nowSec - 600)
  ];
  const state = JSON.stringify({
    schemaVersion: 1, revision: 1, generationId: 'gen:1700000000:ab12',
    currentOrigin: 'PLANNED', currentPlanningDay: '', userAtBase: false,
    baseArrivalUnix: null, latenessHalt: false, currentStatus: '',
    manualReturnCompleted: false,
    trips: { trip_leg0: { observedArrivalUnix: nowSec - 600 } },
    stops: {}, completedStops: {}, completedDropins: {}, manualSessions: {}
  });
  const store = make(master, {}, state);
  assert.strictEqual(store.locals['do_tesla_nav'], 'false',
    'a completed trip must never be re-routed, got do_tesla_nav=' + store.locals['do_tesla_nav']);
  assert.strictEqual(store.locals['itin_mode1'], 'NONE', 'completed trip must leave the dispatcher with no target');
} catch (e) { fail('completed-trip exclusion: ' + e.message); }

// SCN-10: control — the SAME overdue-within-window leg WITHOUT completion
// state is still selected (the exclusion is explicit-state driven, not
// time-driven).
try {
  const master = [
    leg('leg0', aCoords, nowSec - 2400, nowSec - 600)
  ];
  const store = make(master);
  assert.strictEqual(store.locals['itin_mode1'], 'DRIVE',
    'an uncompleted overdue-within-window leg must still be selected');
} catch (e) { fail('uncompleted overdue control: ' + e.message); }

// SCN-11: a non-DRIVE next stop never sequences into the Tesla nav payload —
// a short-dwell WALK leg is a separate navigation mode, regardless of dwell.
try {
  // leg0 DRIVE arrives 23:50; leg1 WALK departs 00:01 (10-min dwell) — the
  // dwell gate would chain it, the mode gate must break it.
  const master = [
    leg('leg0', aCoords, nowSec + 3600, nowSec + 5860, '#dropin'),
    leg('leg1', bCoords, nowSec + 6460, nowSec + 8260, '', 'WALK')
  ];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'a non-DRIVE next stop must never sequence into the Tesla payload, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('non-DRIVE stop mode gate: ' + e.message); }

// SCN-12: a COMPLETED chain stop is never appended to the payload — the
// completion exclusion applies to chain stops too, not just target selection.
try {
  // leg0: uncompleted overdue-within-window DRIVE (selected as bestOverdue);
  // leg1: COMPLETED (observedArrivalUnix) with a 5-min dwell — must NOT chain.
  const master = [
    leg('leg0', aCoords, nowSec - 1800, nowSec - 600, '#dropin'),
    leg('leg1', bCoords, nowSec - 300, nowSec + 1500, '#dropin')
  ];
  const state = JSON.stringify({
    schemaVersion: 1, revision: 1, generationId: 'gen:1700000000:ab12',
    currentOrigin: 'PLANNED', currentPlanningDay: '', userAtBase: false,
    baseArrivalUnix: null, latenessHalt: false, currentStatus: '',
    manualReturnCompleted: false,
    trips: { trip_leg1: { observedArrivalUnix: nowSec - 300 } },
    stops: {}, completedStops: {}, completedDropins: {}, manualSessions: {}
  });
  const store = make(master, {}, state);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'a completed chain stop must never appear in the payload, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('completed chain stop: ' + e.message); }

if (failures > 0) { console.log('FAIL: dispatcher-multi-stop — ' + failures + ' group(s) failed'); process.exit(1); }
console.log('PASS: dispatcher-multi-stop — reversed sequential-stop payload (Bolt plugin contract), length-gate chain, equality-only re-push dedup');
process.exit(0);
