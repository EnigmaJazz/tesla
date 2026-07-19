// INV-0.6 relevance deadline: a leg whose relevance deadline has passed
// MUST be rejected as STALE_TRIP_REJECTED, leaving no actionable trip.
//
// Fixture: one DRIVE leg that departed 5 hours ago and arrived 4 hours ago.
// arriveUnix = nowSec - 4*3600. Default relevance = arriveUnix + 4*3600 = nowSec.
// At nowSec, nowSec > relevanceDeadline, so the leg is truly stale and
// MUST NOT be selected. The Dispatcher must clear stale action outputs,
// emit IDLE_SYNC_ENGAGED, and fall back to the 60-minute idle sync.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const pastDep = nowSec - 5 * 3600;
const pastArr = nowSec - 4 * 3600;

const masterJson = JSON.stringify([
  { mode: 'DRIVE', departUnix: pastDep, arriveUnix: pastArr, targetTitle: 'Stale', targetCoords: '52.0,-2.0' }
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

const testName = 'Dispatcher relevance: truly stale leg rejected; idle sync at 60 min, IDLE_SYNC_ENGAGED';

function fail(msg) {
  console.log('FAIL: ' + testName + ' — ' + msg);
  process.exit(1);
}

try {
  if (store.runError) fail('script threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  // No actionable trip.
  assert.equal(store.locals['itin_mode1'], 'NONE', 'itin_mode1 should be NONE when all legs are stale');
  assert.equal(store.locals['itin_time1'], '0', 'itin_time1 should be 0 when all legs are stale');

  // Structured flash for the stale rejection.
  const staleFlashed = store.flashLog.some(function (entry) {
    return typeof entry === 'string' && entry.indexOf('STALE_TRIP_REJECTED') !== -1;
  });
  if (!staleFlashed) fail('expected STALE_TRIP_REJECTED flash entry, got: ' + JSON.stringify(store.flashLog));

  // Idle sync event.
  const idleFlashed = store.flashLog.some(function (entry) {
    return typeof entry === 'string' && entry.indexOf('IDLE_SYNC_ENGAGED') !== -1;
  });
  if (!idleFlashed) fail('expected IDLE_SYNC_ENGAGED flash entry, got: ' + JSON.stringify(store.flashLog));

  // Sync timing: idle 60 minutes.
  const nextSync = store.globals['Next_Sync'];
  const d = new Date(nowSec * 1000 + 60 * 60 * 1000);
  const expected = (d.getHours() < 10 ? '0' : '') + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  assert.equal(nextSync, expected, 'Next_Sync should be +60 min idle, got ' + nextSync + ' expected ' + expected);

  // Reject the negative-gap 3-min tight loop explicitly.
  const d3 = new Date(nowSec * 1000 + 3 * 60 * 1000);
  const threeMin = (d3.getHours() < 10 ? '0' : '') + d3.getHours() + '.' + (d3.getMinutes() < 10 ? '0' : '') + d3.getMinutes();
  if (nextSync === threeMin) fail('Next_Sync is the +3 min tight-loop bug bucket');

  console.log('PASS: ' + testName);
  console.log('  itin_mode1  = ' + store.locals['itin_mode1']);
  console.log('  itin_time1  = ' + store.locals['itin_time1']);
  console.log('  Next_Sync   = ' + nextSync + ' (expected ' + expected + ' = +60 min)');
  console.log('  STALE flash = ' + (staleFlashed ? 'yes' : 'no'));
  console.log('  IDLE flash  = ' + (idleFlashed ? 'yes' : 'no'));
  process.exit(0);
} catch (e) {
  fail(e.message);
}
