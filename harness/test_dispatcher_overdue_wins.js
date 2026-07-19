// INV-0.6 relevance deadline: an overdue leg that is still within its
// relevance window remains eligible when no future DUE leg exists.
//
// Fixture: one DRIVE leg that departed 1 hour ago and arrived at nowSec.
// arriveUnix = nowSec. Default relevance = arriveUnix + 4*3600 = nowSec + 14400.
// The leg is overdue (depUnix < nowSec) but within its relevance window, so
// it MUST be selected as the actionable trip. Sync timing derives from the
// selected leg: gapMins is negative, which falls through the future ladder to
// SOON_SYNC_MINS (10 minutes). The IDLE_SYNC_ENGAGED path is not taken.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const pastDep = nowSec - 3600;
const pastArr = nowSec;

const masterJson = JSON.stringify([
  { mode: 'DRIVE', departUnix: pastDep, arriveUnix: pastArr, targetTitle: 'Overdue', targetCoords: '52.0,-2.0' }
]);

const globals = {
  Tesla_Last_Scheduled: String(nowSec - 7200),
  Tesla_Last_HVAC_Unix: '0',
  Tesla_Last_Nav: '',
  Google_Last_Nav: '',
  Current_Status: '',
  User_At_AdHoc: ''
};

const files = {
  'Tasker/Tesla/Data/Itin_Master.json': masterJson
};

const { sandbox, store } = createSandbox({ globals: globals, files: files, nowMs: nowSec * 1000 });
const scriptPath = path.resolve(__dirname, '..', 'Dispatcher.js');
runScript(scriptPath, sandbox, store);

const testName = 'Dispatcher relevance: overdue-within-window selected when no future leg; sync = 10 min';

function fail(msg) {
  console.log('FAIL: ' + testName + ' — ' + msg);
  process.exit(1);
}

try {
  if (store.runError) fail('script threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  // The overdue leg is selected.
  assert.equal(store.locals['itin_time1'], String(pastDep), 'itin_time1 should be the overdue leg departUnix');
  assert.equal(store.locals['itin_mode1'], 'DRIVE', 'itin_mode1 should be DRIVE');
  assert.equal(store.locals['itin_loc1'], 'Overdue', 'itin_loc1 should be the overdue leg title');

  // No STALE_TRIP_REJECTED and no IDLE_SYNC_ENGAGED: the leg is actionable.
  const staleFlashed = store.flashLog.some(function (entry) {
    return typeof entry === 'string' && entry.indexOf('STALE_TRIP_REJECTED') !== -1;
  });
  const idleFlashed = store.flashLog.some(function (entry) {
    return typeof entry === 'string' && entry.indexOf('IDLE_SYNC_ENGAGED') !== -1;
  });
  if (staleFlashed) fail('overdue-within-window leg should NOT be rejected as STALE_TRIP_REJECTED');
  if (idleFlashed) fail('overdue-within-window leg should NOT trigger IDLE_SYNC_ENGAGED');

  // gapMins = Math.floor((pastDep - nowSec) / 60) = -60 → falls through to SOON_SYNC_MINS = 10.
  const nextSync = store.globals['Next_Sync'];
  const d = new Date(nowSec * 1000 + 10 * 60 * 1000);
  const expected = (d.getHours() < 10 ? '0' : '') + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  assert.equal(nextSync, expected, 'Next_Sync should be +10 min (SOON_SYNC_MINS), got ' + nextSync + ' expected ' + expected);

  console.log('PASS: ' + testName);
  console.log('  selectedTime = ' + store.locals['itin_time1']);
  console.log('  Next_Sync    = ' + nextSync + ' (10-min bucket, not idle)');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
