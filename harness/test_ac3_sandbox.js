// AC-3: same-location overnight day-boundary regression test (Slice A).
//
// A same-location away event on consecutive local days must terminate today
// with an EOD return and leave tomorrow's first leg base/JIT. Every planned
// queue row must carry planningDay (col 20) and originSource (col 21); the
// boundary handoff must emit EVT-OVERNIGHT_BOUNDARY_CREATED and
// EVT-CROSS_DAY_CHAIN_REJECTED; skip_idx_until must point at the first
// next-day index (tomorrow's rows survive for the next pass).
//
// RED: all assertions below fail against the pre-Slice-A engine (19-column
// rows, no boundary logs, skipIdx swallows the next day).

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;                    // 2023-11-14T22:13:20Z
const homeCoords = "51.9,-2.1";
const awayCoords = "52.45,-2.1";              // ~61 km from home: far enough
                                              // for the boundary EOD, near
                                              // enough to reach same-day
const todayStart = nowSec + 6000;             // 2023-11-14
const tomorrowStart = nowSec + 86400 + 6000;  // 2023-11-15

const SCH3_ORIGIN_SOURCES = [
  "ACTIVE_MANUAL_TRIP",
  "ACTIVE_PLANNED_TRIP",
  "LIVE_BASE",
  "LIVE_LOCATION",
  "CONFIRMED_LAST_DESTINATION",
  "OVERNIGHT_BASE_RESET",
  "LEGACY_ITINERARY_FALLBACK"
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const masterJson = JSON.stringify([
  {
    id: "event_today_kx8f01",
    start: todayStart,
    end: todayStart + 3600,
    duration: 3600,
    title: "Work Today",
    desc: "",
    loc: "Office",
    coords: awayCoords
  },
  {
    id: "event_tomorrow_kx8f02",
    start: tomorrowStart,
    end: tomorrowStart + 3600,
    duration: 3600,
    title: "Work Tomorrow",
    desc: "",
    loc: "Office",
    coords: awayCoords
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

const commonFiles = {
  "Tasker/Tesla/Data/Itin_Master.json": "[]",
  "Tasker/Tesla/Data/TDS_Master.json": masterJson,
  "Tasker/Tesla/Data/TDS_Base_Geocodes.txt": baseGeocodes,
  "Tasker/Tesla/Data/TDS_Overrides.json": "{}",
  "Tasker/Tesla/Data/Temp_Route_Cache.txt": "",
  "Tasker/Tesla/Data/RouteCache.txt": ""
};

const commonGlobals = {
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

const commonLocals = {
  idx: "1",
  virtual_loc: homeCoords,
  vcar_loc: homeCoords,
  virtual_time: String(nowSec)
};

const scriptPath = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

function fail(msg) {
  console.log('FAIL: AC-3 Sandbox — ' + msg);
  process.exit(1);
}

try {
  // -----------------------------------------------------------------
  // Pass 1: today's event + tomorrow's same-location event. The engine must
  // terminate today at the boundary and preserve tomorrow's rows.
  // -----------------------------------------------------------------
  const { sandbox, store } = createSandbox({
    locals: Object.assign({}, commonLocals),
    globals: Object.assign({}, commonGlobals),
    files: Object.assign({}, commonFiles),
    nowMs: nowSec * 1000
  });
  runScript(scriptPath, sandbox, store);
  if (store.runError) fail('pass 1 threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  const queue = store.locals['block_queue'];
  if (!queue || queue === "EOF") fail('pass 1 expected non-empty block_queue');
  const env = JSON.parse(queue);
  if (env.schemaVersion !== 1 || env.eof !== false) fail('pass 1 block_queue must be a schemaVersion-1 non-EOF envelope');
  const rows = env.rows;

  rows.forEach(function (row, i) {
    if (!row.planningDay || !DAY_RE.test(row.planningDay)) fail('row ' + i + ' planningDay must be YYYY-MM-DD, got ' + JSON.stringify(row.planningDay));
    if (SCH3_ORIGIN_SOURCES.indexOf(row.originSource) === -1) {
      fail('row ' + i + ' originSource must be in SCH-3 enum, got ' + JSON.stringify(row.originSource));
    }
  });

  const boundaryFlash = store.flashLog.some(function (m) {
    return m.indexOf('OVERNIGHT_BOUNDARY_CREATED') !== -1;
  });
  if (!boundaryFlash) fail('expected EVT-OVERNIGHT_BOUNDARY_CREATED flash');

  const crossDayFlash = store.flashLog.some(function (m) {
    return m.indexOf('CROSS_DAY_CHAIN_REJECTED') !== -1;
  });
  if (!crossDayFlash) fail('expected EVT-CROSS_DAY_CHAIN_REJECTED flash');

  const skip = env.skipIdxUntil;
  if (skip !== 2) fail('skipIdxUntil should be 2 (first next-day index), got ' + JSON.stringify(skip));

  const head = rows[0];
  if (head.planningDay !== "2023-11-14") fail('head planningDay should be 2023-11-14, got ' + head.planningDay);
  if (head.originSource !== "LIVE_BASE") fail('head originSource should be LIVE_BASE, got ' + head.originSource);
  if (head.departurePolicy !== "JIT") fail('head departurePolicy should be JIT, got ' + head.departurePolicy);

  if (env.stepConflict !== null && env.stepConflict !== "") {
    fail('pass 1 stepConflict should be null/empty, got ' + JSON.stringify(env.stepConflict));
  }
  if (!Array.isArray(env.notifications)) fail('pass 1 notifications must be an array');

  // -----------------------------------------------------------------
  // Pass 2: next invocation starts at tomorrow's index with an itinerary tail
  // that records the overnight EOD return. Tomorrow's first leg must be
  // planned from base with JIT policy and a next-day planningDay.
  // -----------------------------------------------------------------
  const itinAfterBoundary = JSON.stringify([
    {
      tripId: "eod_overnight",
      targetEventId: "event_today_kx8f01",
      mode: "EOD_RETURN",
      pitstopState: "end_of_day",
      departUnix: todayStart + 3600,
      arriveUnix: todayStart + 7200
    }
  ]);

  const { sandbox: sandbox2, store: store2 } = createSandbox({
    locals: Object.assign({}, commonLocals, { idx: "2" }),
    globals: Object.assign({}, commonGlobals),
    files: Object.assign({}, commonFiles, {
      "Tasker/Tesla/Data/Itin_Master.json": itinAfterBoundary
    }),
    nowMs: (nowSec + 86400) * 1000
  });
  runScript(scriptPath, sandbox2, store2);
  if (store2.runError) fail('pass 2 threw: ' + store2.runError.message + ' (line ' + store2.runError.line + ')');

  const queue2 = store2.locals['block_queue'];
  if (!queue2 || queue2 === "EOF") fail('pass 2 expected non-empty block_queue');
  const env2 = JSON.parse(queue2);
  const head2 = env2.rows[0];
  if (!head2) fail('pass 2 expected a head row');
  if (head2.planningDay !== "2023-11-15") fail('pass 2 head planningDay should be 2023-11-15, got ' + head2.planningDay);
  if (SCH3_ORIGIN_SOURCES.indexOf(head2.originSource) === -1) {
    fail('pass 2 head originSource must be in SCH-3 enum, got ' + JSON.stringify(head2.originSource));
  }
  if (head2.departurePolicy !== "JIT") fail('pass 2 head departurePolicy should be JIT, got ' + head2.departurePolicy);

  console.log('PASS: AC-3 Sandbox: same-location overnight terminates today; tomorrow survives base/JIT');
  console.log('  pass 1: rows = ' + rows.length + ', skipIdxUntil = ' + skip);
  console.log('  pass 1: head planningDay = ' + head.planningDay + ', originSource = ' + head.originSource + ', policy = ' + head.departurePolicy);
  console.log('  pass 2: head planningDay = ' + head2.planningDay + ', originSource = ' + head2.originSource + ', policy = ' + head2.departurePolicy);
  process.exit(0);
} catch (e) {
  fail(e.message);
}
