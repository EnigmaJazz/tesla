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

function make(master, extraGlobals) {
  const globals = Object.assign({
    Tesla_Last_Scheduled: '0', Tesla_Last_HVAC_Unix: '0', Tesla_Last_Nav: '',
    Google_Last_Nav: '', Current_Status: '', User_At_AdHoc: '',
    TDS_Active_Generation: 'gen:1700000000:ab12'
  }, extraGlobals || {});
  const { sandbox, store } = createSandbox({
    globals: globals,
    files: { [DATA + 'Itin_Master.json']: JSON.stringify(master), [DATA + 'TDS_Trip_State.json']: '{}' },
    nowMs: nowSec * 1000
  });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error('Dispatcher crashed: ' + store.runError.message);
  return store;
}

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: dispatcher-multi-stop — ' + msg); }

function leg(id, coords, departSec, arriveSec, desc) {
  return {
    targetEventId: id, targetTitle: 'Stop ' + id, targetCoords: coords,
    targetDesc: desc || '', mode: 'DRIVE',
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

// SCN-4: midnight-straddle — a next stop DEPARTING after local midnight must
// break the chain (no day-boundary crossing), even though the target leg's
// own arrival crosses midnight.
try {
  // leg0 departs 23:13, arrives 23:43 (day 14); leg1 departs 00:10 (day 15).
  const master = [
    leg('leg0', aCoords, nowSec + 3600, nowSec + 5400, '#dropin'),
    leg('leg1', bCoords, nowSec + 9400, nowSec + 11200, '#dropin')
  ];
  const store = make(master);
  assert.strictEqual(store.locals['tds_next_coords'], aCoords,
    'a stop departing on the next local day must break the chain, got: ' + store.locals['tds_next_coords']);
} catch (e) { fail('midnight-straddle chain break: ' + e.message); }

// SCN-2: broken chain (next stop on a different local day) -> single coords.
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

if (failures > 0) { console.log('FAIL: dispatcher-multi-stop — ' + failures + ' group(s) failed'); process.exit(1); }
console.log('PASS: dispatcher-multi-stop — reversed sequential-stop payload (Bolt plugin contract), single/broken chains unchanged');
process.exit(0);
