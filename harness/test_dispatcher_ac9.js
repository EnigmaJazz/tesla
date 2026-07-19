// AC-9: Stale departure detail.
// A master with one past and one future leg must select the future leg.
// The past leg must be rejected and logged as STALE_TRIP_REJECTED.
//
// After Patch B' (targetDrive.depUnix → targetDrive.departUnix typo fix),
// the gapMins calculation is correct: a 60-min future leg lands in the
// >30 bucket → syncIntervalMins = 30.
//
// Sync timing is verified through the global `Next_Sync` (HH.MM in local
// time, computed as `Date.now() + syncIntervalMins * 60_000`). TZ=UTC
// and a pinned nowMs make the expected string deterministic.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const futureDep = nowSec + 3600;        // 60 min ahead
const pastDep   = nowSec - 3600;

const masterJson = JSON.stringify([
  { mode: "DRIVE", departUnix: pastDep,   targetTitle: "Past",   targetCoords: "52.0,-2.0" },
  { mode: "DRIVE", departUnix: futureDep, targetTitle: "Future", targetCoords: "53.0,-1.0" }
]);

const globals = {
  Tesla_Last_Scheduled: String(nowSec - 7200),  // 2h ago
  Tesla_Last_HVAC_Unix: "0",
  Tesla_Last_Nav: "",
  Google_Last_Nav: "",
  Current_Status: "",
  User_At_AdHoc: ""
};

const files = {
  "Tasker/Tesla/Data/Itin_Master.json": masterJson
};

const { sandbox, store } = createSandbox({ globals: globals, files: files, nowMs: nowSec * 1000 });
const scriptPath = path.resolve(__dirname, '..', 'Dispatcher.js');
runScript(scriptPath, sandbox, store);

const testName = 'AC-9 Dispatcher: selects future leg, rejects past, sync = 30 min bucket';

function fail(msg) {
  console.log('FAIL: ' + testName + ' — ' + msg);
  process.exit(1);
}

try {
  if (store.runError) fail('script threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  // The Dispatcher publishes its action decision via setLocal('itin_time1', ...)
  // and the loop hits STALE_TRIP_REJECTED via flash() for the past leg.
  const selectedTime = store.locals['itin_time1'];
  assert.equal(selectedTime, String(futureDep), 'itin_time1 should be the future leg departUnix');
  if (selectedTime === String(pastDep)) fail('selected the past leg, not the future one');

  const selectedMode = store.locals['itin_mode1'];
  assert.equal(selectedMode, 'DRIVE', 'itin_mode1 should be the future leg mode');

  const selectedLoc = store.locals['itin_loc1'];
  assert.equal(selectedLoc, 'Future', 'itin_loc1 should be the future leg title');

  // Structured flash for the stale rejection: at least one STALE_TRIP_REJECTED entry.
  const staleFlashed = store.flashLog.some(function (entry) {
    return typeof entry === 'string' && entry.indexOf('STALE_TRIP_REJECTED') !== -1;
  });
  if (!staleFlashed) fail('expected at least one STALE_TRIP_REJECTED flash entry, got: ' + JSON.stringify(store.flashLog));

  // sync timing: assert the future leg drives the bucket (not the past one)
  // and that we are in the correct 30-min bucket for a 60-min gap.
  // gapMins = Math.floor((1700003600 - 1700000000) / 60) = 60 → 60 > 30 → syncIntervalMins = 30.
  const nextSync = store.globals['Next_Sync'];

  function hhmmFromNow(plusMin) {
    const d = new Date(nowSec * 1000 + plusMin * 60 * 1000);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  const thirtyMin = hhmmFromNow(30);
  const threeMin  = hhmmFromNow(3);

  assert.equal(nextSync, thirtyMin, 'Next_Sync should be the +30 min bucket for a 60-min gap, got ' + nextSync);
  if (nextSync === threeMin) fail('Next_Sync is the +3 min tight-loop bug bucket');

  console.log('PASS: ' + testName);
  console.log('  selectedTime   = ' + selectedTime + ' (future=' + futureDep + ')');
  console.log('  Next_Sync      = ' + nextSync + ' (30-min bucket, not 3)');
  console.log('  STALE flash    = ' + (staleFlashed ? 'yes' : 'no'));
  process.exit(0);
} catch (e) {
  fail(e.message);
}
