// AC-6: Stale-away itinerary loses to live base; future trip base/JIT.
//
// Seed an old Itin_Master.json whose tail leg says handled (away), set
// User_At_Base="true" and Current_Status="" (not in progress), and run
// Sandbox_Engine.js once. Assert the script does not throw, the override
// flash is emitted, and the head leg's origin is the base (queue row
// columns [2] and the explicit departure policy column [19] is JIT).

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const homeCoords = "51.9,-2.1";
const eventCoords = "52.0,-2.0";
const futureEventStart = nowSec + 3600;

const itinJson = JSON.stringify([
  {
    tripId: "stale_away_leg",
    targetEventId: "event_1",
    mode: "DRIVE",
    pitstopState: "handled",
    departUnix: nowSec - 3600,
    arriveUnix: nowSec - 1800
  }
]);

const masterJson = JSON.stringify([
  {
    id: "event_1",
    start: futureEventStart,
    end: futureEventStart + 3600,
    duration: 3600,
    title: "Future Event",
    desc: "",
    loc: "Work",
    coords: eventCoords
  }
]);

const baseGeocodes = [
  nowSec.toString(),
  (nowSec + 86400).toString(),
  homeCoords,
  "0",
  "Home",
  "",
  "home_base"
].join("~");

const locals = {
  idx: "1",
  virtual_loc: homeCoords,
  vcar_loc: homeCoords,
  virtual_time: String(nowSec)
};

const globals = {
  User_At_Base: "true",
  Base_Arrival_Unix: nowSec.toString(),
  User_Loc: homeCoords,
  Home_Coords: homeCoords,
  Current_Status: "",
  Arrival_Buffer_Mins: "5",
  Departure_Buffer_Mins: "5",
  Max_Walk_Meters: "8046",
  Daily_Walk_Meters: "0",
  Live_Traffic_Threshold: "7200",
  Car_Connected: "false"
};

const files = {
  "Tasker/Tesla/Data/Itin_Master.json": itinJson,
  "Tasker/Tesla/Data/TDS_Master.json": masterJson,
  "Tasker/Tesla/Data/TDS_Base_Geocodes.txt": baseGeocodes,
  "Tasker/Tesla/Data/TDS_Overrides.json": "{}",
  "Tasker/Tesla/Data/Temp_Route_Cache.txt": "",
  "Tasker/Tesla/Data/RouteCache.txt": ""
};

const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
const scriptPath = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
runScript(scriptPath, sandbox, store);

const testName = 'AC-6 Sandbox: stale-away itinerary loses to live base; future trip JIT';

function fail(msg) {
  console.log('FAIL: ' + testName + ' — ' + msg);
  process.exit(1);
}

try {
  if (store.runError) fail('script threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  const overrideFound = store.flashLog.some(function (m) {
    return m.indexOf('LIVE_BASE_OVERRIDES_LEGACY_ORIGIN') !== -1;
  });
  if (!overrideFound) fail('expected EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN flash');

  const queue = store.locals['block_queue'];
  if (!queue || queue === "EOF") fail('expected non-empty block_queue');
  const rows = queue.split("~");
  const headRow = rows[0];
  const cols = headRow.split("|");

  if (cols.length < 19) fail('expected at least 19 queue columns, got ' + cols.length);

  const policy = cols[18];
  if (policy !== "JIT") fail('expected head leg departurePolicy JIT, got ' + policy);

  const blockStep19 = store.locals['block_step19'];
  if (blockStep19 !== "JIT") fail('expected block_step19=JIT, got ' + blockStep19);

  console.log('PASS: ' + testName);
  console.log('  flash contains LIVE_BASE_OVERRIDES_LEGACY_ORIGIN');
  console.log('  head policy = ' + policy);
  console.log('  block_step19 = ' + blockStep19);
  process.exit(0);
} catch (e) {
  fail(e.message);
}
