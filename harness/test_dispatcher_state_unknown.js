// P1-3 / P1-5: Dispatcher degradation when generation/trip state is UNKNOWN.
//   P1-3: with trip state unreadable the OVERDUE-within-window class is
//         withheld (a completed trip still in the committed itinerary could
//         otherwise be re-routed); future/PLANNED selection is unaffected.
//   P1-5: a failed master read retries in SOON_SYNC_MINS instead of idling.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');

const globals = {
  Tesla_Last_Scheduled: String(nowSec - 7200), Tesla_Last_HVAC_Unix: '0', Tesla_Last_Nav: '',
  Google_Last_Nav: '', Current_Status: '', User_At_AdHoc: '',
  TDS_Active_Generation: 'gen:1700000000:ab12'
};

function make(files) {
  const { sandbox, store } = createSandbox({ globals: globals, files: files || {}, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error('Dispatcher threw: ' + store.runError.message);
  return store;
}
function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function hasCode(store, code) {
  return logs(store).some(function (l) { return l.code === code; });
}
function nextSyncAt(plusMin) {
  const d = new Date(nowSec * 1000 + plusMin * 60000);
  return (d.getHours() < 10 ? '0' : '') + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: dispatcher-state-unknown — ' + msg); }

// Overdue-within-window: departed 40 min ago, arrived 10 min ago. Without
// completion state this is bestOverdue; with UNKNOWN state it must be withheld.
const overdueMaster = JSON.stringify([{
  tripId: 'trip_overdue', mode: 'DRIVE', departUnix: nowSec - 2400, arriveUnix: nowSec - 600,
  targetTitle: 'Overdue', targetCoords: '52.0,-2.0'
}]);

// D1 (P1-3/R3): an UNREADABLE trip state (corrupt) -> the overdue class is withheld.
try {
  const store = make({ [DATA + 'Itin_Master.json']: overdueMaster, [DATA + 'TDS_Trip_State.json']: '{oops' });
  assert.strictEqual(store.locals['itin_mode1'], 'NONE', 'overdue leg must not be selected when state is UNKNOWN');
  assert.strictEqual(store.locals['itin_time1'], '0', 'no actionable time when overdue is suppressed');
  assert(hasCode(store, 'OVERDUE_SUPPRESSED_STATE_UNKNOWN'), 'suppression must be logged');
} catch (e) { fail('overdue suppressed: ' + e.message); }

// D2 (P1-3 control): readable (empty) trip state -> overdue leg still selected.
try {
  const store = make({ [DATA + 'Itin_Master.json']: overdueMaster, [DATA + 'TDS_Trip_State.json']: '{}' });
  assert.strictEqual(store.locals['itin_mode1'], 'DRIVE', 'overdue leg must still be selected with readable state');
  assert(!hasCode(store, 'OVERDUE_SUPPRESSED_STATE_UNKNOWN'), 'no suppression with readable state');
} catch (e) { fail('overdue readable-state control: ' + e.message); }

// D3 (R4): an UNREADABLE master (read/parse failure) selects the short retry.
try {
  const store = make({ [DATA + 'Itin_Master.json']: '{oops' });
  assert(hasCode(store, 'GENERATION_READ_UNKNOWN_SYNC'), 'a failed master read must log GENERATION_READ_UNKNOWN_SYNC');
  assert(!hasCode(store, 'IDLE_SYNC_ENGAGED'), 'a failed master read must not idle-sync');
  assert.strictEqual(store.globals['Next_Sync'], nextSyncAt(10), 'failed master read must retry in SOON_SYNC_MINS (10)');
} catch (e) { fail('short retry on unknown master: ' + e.message); }

// D4 (P1-5 control): a readable-but-empty master keeps the idle interval.
try {
  const store = make({ [DATA + 'Itin_Master.json']: '[]' });
  assert(hasCode(store, 'IDLE_SYNC_ENGAGED'), 'a readable empty master must idle-sync');
  assert(!hasCode(store, 'GENERATION_READ_UNKNOWN_SYNC'), 'a readable empty master must not log the unknown sync');
  assert.strictEqual(store.globals['Next_Sync'], nextSyncAt(60), 'readable empty master must idle at IDLE_SYNC_MINS (60)');
} catch (e) { fail('idle on readable empty master: ' + e.message); }

// D5 (R3): an ABSENT trip state is a legitimate "nothing recorded yet" — the
// overdue class proceeds and the absence is diagnosable.
try {
  const store = make({ [DATA + 'Itin_Master.json']: overdueMaster });
  assert.strictEqual(store.locals['itin_mode1'], 'DRIVE', 'overdue leg must be selected when state is absent (known-empty)');
  assert(hasCode(store, 'TRIP_STATE_ABSENT'), 'an absent state file must log TRIP_STATE_ABSENT');
  assert(!hasCode(store, 'OVERDUE_SUPPRESSED_STATE_UNKNOWN'), 'an absent state file must not suppress the overdue class');
} catch (e) { fail('absent trip state proceeds: ' + e.message); }

// D6 (R3): a %-unexpanded trip state is UNREADABLE -> still suppressed.
try {
  const store = make({ [DATA + 'Itin_Master.json']: overdueMaster, [DATA + 'TDS_Trip_State.json']: '%TDS_Trip_State' });
  assert.strictEqual(store.locals['itin_mode1'], 'NONE', 'unexpanded state must withhold the overdue class');
  assert(hasCode(store, 'OVERDUE_SUPPRESSED_STATE_UNKNOWN'), 'unexpanded state must log suppression');
  assert(!hasCode(store, 'TRIP_STATE_ABSENT'), 'unreadable state must not be reported as absent');
} catch (e) { fail('unexpanded trip state suppressed: ' + e.message); }

if (failures > 0) { console.log('FAIL: dispatcher-state-unknown — ' + failures + ' scenario(s) failed'); process.exit(1); }
console.log('PASS: dispatcher-state-unknown — overdue suppressed on UNKNOWN state; failed master read retries short');
process.exit(0);
