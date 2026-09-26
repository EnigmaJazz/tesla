// P2 regression coverage for Dispatcher chain validation and the Sandbox EOD horizon.

process.env.TZ = 'Europe/London';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
const SANDBOX_ENGINE = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
const EOD_HORIZON_INCLUSIVE_OFFSET_SECS = 1;

function makeDispatcher(master) {
  const globals = {
    Tesla_Last_Scheduled: '0', Tesla_Last_HVAC_Unix: '0', Tesla_Last_Nav: '',
    Google_Last_Nav: '', Current_Status: '', User_At_AdHoc: '',
    TDS_Active_Generation: 'gen:1700000000:ab12'
  };
  const { sandbox, store } = createSandbox({
    globals: globals,
    files: { [DATA + 'Itin_Master.json']: JSON.stringify(master), [DATA + 'TDS_Trip_State.json']: '{}' },
    nowMs: nowSec * 1000
  });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error('Dispatcher crashed: ' + store.runError.message);
  return store;
}

function dispatcherLeg(id, coords, departUnix, arriveUnix) {
  return {
    tripId: 'trip_' + id, targetEventId: id, targetTitle: 'Stop ' + id,
    targetCoords: coords, targetDesc: '#dropin', mode: 'DRIVE',
    departUnix: departUnix, arriveUnix: arriveUnix, durationSecs: 1800
  };
}

function logs(store) {
  return (store.flashLog || []).map(function (item) {
    try { return JSON.parse(item); } catch (e) { return null; }
  }).filter(Boolean);
}

function runSandboxHorizon(nowUnix) {
  const date = new Date(nowUnix * 1000);
  const expectedDays = 8;
  const expectedBoundary = new Date(date.getFullYear(), date.getMonth(), date.getDate() + expectedDays).getTime() / 1000;
  const eventStart = expectedBoundary + 1800;
  const event = {
    id: 'event_horizon_test', start: eventStart, end: eventStart + 3600,
    duration: 3600, title: 'Horizon Probe', desc: '', loc: 'Office', coords: '52.5,-1.5'
  };
  const files = {
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Master.json']: JSON.stringify([event]),
    [DATA + 'TDS_Base_Geocodes.txt']: [String(nowUnix), String(nowUnix + 86400), '51.9,-2.1', '0', 'Home', '', 'home_base'].join('~'),
    [DATA + 'TDS_Overrides.json']: '{}',
    [DATA + 'Temp_Route_Cache.txt']: '',
    [DATA + 'RouteCache.txt']: ''
  };
  const globals = {
    User_At_Base: 'true', Base_Arrival_Unix: String(nowUnix), User_Loc: '51.9,-2.1',
    Home_Coords: '51.9,-2.1', Current_Status: '', Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5', Max_Walk_Meters: '8046', Daily_Walk_Meters: '0',
    Live_Traffic_Threshold: '7200', Car_Connected: 'false', TDS_Active_Generation: 'gen:1700000000:ab12'
  };
  const locals = { idx: '1', vcar_loc: '51.9,-2.1', virtual_time: String(nowUnix) };
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowUnix * 1000 });
  let source = fs.readFileSync(SANDBOX_ENGINE, 'utf8');
  const horizonAssignment = 'const sevenDayHorizonSec = horizonDayStartUnix - EOD_HORIZON_INCLUSIVE_OFFSET_SECS;';
  assert.strictEqual(source.split(horizonAssignment).length - 1, 1, 'must instrument the production EOD horizon assignment exactly once');
  source = source.replace(horizonAssignment, horizonAssignment + "\n        setLocal('p2_test_horizon', String(sevenDayHorizonSec));\n        setLocal('p2_test_horizon_days', String(EOD_HORIZON_DAYS));");
  vm.runInContext(source, vm.createContext(sandbox), { filename: SANDBOX_ENGINE });
  if (store.runError) throw new Error('Sandbox_Engine crashed: ' + store.runError.message);
  assert.notStrictEqual(store.locals.p2_test_horizon, undefined, 'master row must reach the production horizon calculation path');
  assert.strictEqual(Number(store.locals.p2_test_horizon_days), expectedDays, 'fixture must use the configured EOD_HORIZON_DAYS');
  assert.strictEqual(Number(store.locals.p2_test_horizon), expectedBoundary - EOD_HORIZON_INCLUSIVE_OFFSET_SECS,
    'EOD horizon must be the inclusive second before local midnight ' + expectedDays + ' calendar days ahead');
}

let failures = 0;
function check(name, fn) {
  try { fn(); } catch (e) { failures += 1; console.log('FAIL: p2-chain-horizon — ' + name + ': ' + e.message); }
}

// A1: malformed departure breaks the chain and leaves all later stops out.
check('invalid departure breaks chain and warns', function () {
  const a = '51.9,-2.1';
  const b = '52.0,-2.0';
  const c = '52.1,-2.3';
  const master = [
    dispatcherLeg('a', a, nowSec + 1800, nowSec + 3600),
    dispatcherLeg('b', b, 'not-a-timestamp', nowSec + 5400),
    dispatcherLeg('c', c, nowSec + 6000, nowSec + 7800)
  ];
  const store = makeDispatcher(master);
  assert.strictEqual(store.locals.tds_next_coords, a, 'malformed departure must leave only the head stop in the payload');
  const warning = logs(store).find(function (entry) { return entry.code === 'CHAIN_BREAK_INVALID_DEPART'; });
  assert(warning, 'malformed departure must flash CHAIN_BREAK_INVALID_DEPART');
  assert.strictEqual(warning.severity, 'warn', 'chain-break severity must be lowercase warn');
});

// A1 control: time-only legs preserve the legacy nextT.time fallback.
check('time-only departure still sequences', function () {
  const a = '51.9,-2.1';
  const b = '52.0,-2.0';
  const master = [
    dispatcherLeg('a', a, nowSec + 1800, nowSec + 3600),
    { tripId: 'trip_b', targetEventId: 'b', targetTitle: 'Stop b', targetCoords: b,
      targetDesc: '#dropin', mode: 'DRIVE', time: nowSec + 4200,
      arriveUnix: nowSec + 6000, durationSecs: 1800 }
  ];
  const store = makeDispatcher(master);
  assert.strictEqual(store.locals.tds_next_coords, b + '~' + a, 'a leg carrying only time must remain in the nav sequence');
});

// A2: both DST directions retain exact local-midnight calendar arithmetic.
check('spring-forward horizon is local calendar midnight', function () {
  runSandboxHorizon(Date.parse('2026-03-25T12:00:00Z') / 1000);
});
check('fall-back horizon is local calendar midnight', function () {
  runSandboxHorizon(Date.parse('2026-10-22T12:00:00Z') / 1000);
});

if (failures > 0) { console.log('FAIL: p2-chain-horizon — ' + failures + ' case(s) failed'); process.exit(1); }
console.log('PASS: p2-chain-horizon — malformed departures break chains, time-only fallback sequences, DST horizons use local calendar midnight');
process.exit(0);
