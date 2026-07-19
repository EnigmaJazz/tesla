// AC-10: No actionable trip detail.
// With an empty Itin_Master, the Dispatcher must use idle sync of at
// least 60 minutes and emit IDLE_SYNC_ENGAGED.
//
// The Dispatcher enters the idle branch when targetDrive is undefined
// AND isActionLocked is false. Our sandbox defaults make both true:
// TDS_Action_Lock.json is absent (no lock), Current_Status is empty
// (not driving), and User_At_AdHoc is empty (not ad-hoc). The branch
// sets syncIntervalMins = IDLE_SYNC_MINS = 60 and flashes the
// IDLE_SYNC_ENGAGED event with details.syncIntervalMins = 60.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;

const globals = {
  Tesla_Last_Scheduled: String(nowSec - 7200),
  Tesla_Last_HVAC_Unix: "0",
  Tesla_Last_Nav: "",
  Google_Last_Nav: "",
  Current_Status: "",
  User_At_AdHoc: ""
};

const files = {
  "Tasker/Tesla/Data/Itin_Master.json": "[]"
};

const { sandbox, store } = createSandbox({ globals: globals, files: files, nowMs: nowSec * 1000 });
const scriptPath = path.resolve(__dirname, '..', 'Dispatcher.js');
runScript(scriptPath, sandbox, store);

const testName = 'AC-10 Dispatcher: empty master → idle sync at 60 min, IDLE_SYNC_ENGAGED';

function fail(msg) {
  console.log('FAIL: ' + testName + ' — ' + msg);
  process.exit(1);
}

try {
  if (store.runError) fail('script threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  // IDLE_SYNC_ENGAGED structured flash.
  const idleFlashed = store.flashLog.some(function (entry) {
    return typeof entry === 'string' && entry.indexOf('IDLE_SYNC_ENGAGED') !== -1;
  });
  if (!idleFlashed) fail('expected IDLE_SYNC_ENGAGED flash entry, got: ' + JSON.stringify(store.flashLog));

  // itin_mode1 should be 'NONE' (else branch at :201).
  assert.equal(store.locals['itin_mode1'], 'NONE', 'itin_mode1 should be NONE for empty master');
  assert.equal(store.locals['itin_time1'], '0', 'itin_time1 should be 0 for empty master');

  // sync timing: IDLE_SYNC_MINS = 60. nextSync = nowMs + 60 min.
  const nextSync = store.globals['Next_Sync'];
  const d = new Date(nowSec * 1000 + 60 * 60 * 1000);
  const expected = (d.getHours() < 10 ? '0' : '') + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  assert.equal(nextSync, expected, 'Next_Sync should be +60 min idle, got ' + nextSync + ' expected ' + expected);

  // Reject the negative-gap 3-min tight loop explicitly.
  const d3 = new Date(nowSec * 1000 + 3 * 60 * 1000);
  const threeMin = (d3.getHours() < 10 ? '0' : '') + d3.getHours() + '.' + (d3.getMinutes() < 10 ? '0' : '') + d3.getMinutes();
  if (nextSync === threeMin) fail('Next_Sync is the +3 min tight-loop bug bucket');

  console.log('PASS: ' + testName);
  console.log('  Next_Sync   = ' + nextSync + ' (expected ' + expected + ' = +60 min)');
  console.log('  IDLE flash  = ' + (idleFlashed ? 'yes' : 'no'));
  process.exit(0);
} catch (e) {
  fail(e.message);
}
