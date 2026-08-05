// AC-6: Stale-away itinerary loses to live base; future trip base/JIT.
//
// Seed an old Itin_Master.json whose tail leg says handled (away), set
// User_At_Base="true" and Current_Status="" (not in progress), and run
// Sandbox_Engine.js once. Two fixtures are exercised:
//   1. virtual_loc at home (the original control) — head origin must be home.
//   2. virtual_loc at a stale-away city (the probe) — live base must override
//      the stale virtual origin, so the head queue row's origin column is the
//      home base coords and the override flash is emitted.
// Every planned queue row must carry an explicit ASAP/JIT policy in its final
// |-delimited field.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const homeCoords = "51.9,-2.1";
const awayCoords = "50.0,-1.0"; // stale-away virtual origin probe
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
    id: "event_1_kx8f00",
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

const commonFiles = {
  "Tasker/Tesla/Data/Itin_Master.json": itinJson,
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
  vcar_loc: homeCoords,
  virtual_time: String(nowSec)
};

const scriptPath = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

function buildSandbox(virtualLoc) {
  return createSandbox({
    locals: Object.assign({}, commonLocals, { virtual_loc: virtualLoc }),
    globals: Object.assign({}, commonGlobals),
    files: Object.assign({}, commonFiles),
    nowMs: nowSec * 1000
  });
}

function runScenario(virtualLoc) {
  const { sandbox, store } = buildSandbox(virtualLoc);
  runScript(scriptPath, sandbox, store);
  return store;
}

function assertRowsHavePolicy(rows, label) {
  rows.forEach(function (row, idx) {
    const cols = row.split("|");
    const policy = cols[18];
    if (policy !== "ASAP" && policy !== "JIT") {
      throw new Error(label + ' row ' + idx + ' missing explicit ASAP/JIT policy at col 19 (got ' + JSON.stringify(policy) + ')');
    }
  });
}

function fail(msg) {
  console.log('FAIL: AC-6 Sandbox — ' + msg);
  process.exit(1);
}

try {
  // Fixture 1: control — virtual origin already at home.
  const storeHome = runScenario(homeCoords);
  if (storeHome.runError) fail('control fixture threw: ' + storeHome.runError.message + ' (line ' + storeHome.runError.line + ')');

  const queueHome = storeHome.locals['block_queue'];
  if (!queueHome || queueHome === "EOF") fail('control fixture expected non-empty block_queue');
  const rowsHome = queueHome.split("~");
  const headHome = rowsHome[0].split("|");
  if (headHome.length < 18) fail('control head expected at least 18 columns, got ' + headHome.length);
  if (headHome[18] !== "JIT") fail('control head policy (col 19) should be JIT, got ' + headHome[18]);
  assertRowsHavePolicy(rowsHome, 'control');

  const overrideHome = storeHome.flashLog.some(function (m) {
    return m.indexOf('LIVE_BASE_OVERRIDES_LEGACY_ORIGIN') !== -1;
  });
  if (!overrideHome) fail('control fixture expected EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN flash');

  // Fixture 2: probe — stale-away virtual origin must be overridden to home.
  const storeAway = runScenario(awayCoords);
  if (storeAway.runError) fail('stale-away fixture threw: ' + storeAway.runError.message + ' (line ' + storeAway.runError.line + ')');

  const overrideAway = storeAway.flashLog.some(function (m) {
    return m.indexOf('LIVE_BASE_OVERRIDES_LEGACY_ORIGIN') !== -1;
  });
  if (!overrideAway) fail('stale-away fixture expected EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN flash');

  const queueAway = storeAway.locals['block_queue'];
  if (!queueAway || queueAway === "EOF") fail('stale-away fixture expected non-empty block_queue');
  const rowsAway = queueAway.split("~");
  const headAway = rowsAway[0].split("|");
  if (headAway.length < 18) fail('stale-away head expected at least 18 columns, got ' + headAway.length);

  // Direct origin assertion: the head EVENT row is the future event, so its
  // destination coords (column 2) are the event coords, not the stale-away
  // virtual_loc. The EOD_RETURN row's destination is the configured home
  // coords, proving the queue is anchored to the live base rather than away.
  const headAwayDestCoords = headAway[2];
  if (headAwayDestCoords !== eventCoords) {
    fail('stale-away head destination coords should be eventCoords (' + eventCoords + '), got ' + headAwayDestCoords);
  }
  const awayCoordsLeaked = rowsAway.some(function (row) {
    return row.split("|")[2] === awayCoords;
  });
  if (awayCoordsLeaked) fail('stale-away virtual_loc (' + awayCoords + ') leaked into a queue row destination');

  const eodReturnRow = rowsAway.find(function (row) { return row.split("|")[0] === "EOD_RETURN"; });
  if (!eodReturnRow) fail('stale-away fixture expected an EOD_RETURN row');
  const eodReturnDestCoords = eodReturnRow.split("|")[2];
  if (eodReturnDestCoords !== homeCoords) {
    fail('stale-away EOD_RETURN destination coords should be homeCoords (' + homeCoords + '), got ' + eodReturnDestCoords);
  }

  // The stale-away virtual origin must be overridden to the live base. The
  // strongest observable signal is that the planned queue becomes identical to
  // the control fixture (home origin) — same route origin, same policy, same JIT.
  if (queueAway !== queueHome) {
    fail('stale-away queue should match control queue after live-base override;\n  away:   ' + queueAway + '\n  home:   ' + queueHome);
  }

  const headPolicy = headAway[18];
  if (headPolicy !== "JIT") fail('stale-away head policy (col 19) should be JIT, got ' + headPolicy);

  const blockStep19 = storeAway.locals['block_step19'];
  if (blockStep19 !== "JIT") fail('stale-away block_step19 should be JIT, got ' + blockStep19);

  assertRowsHavePolicy(rowsAway, 'stale-away');

  // Slice A: every queue row must carry planningDay (col 20, YYYY-MM-DD) and
  // originSource (col 21, SCH-3 enum). The live base override must surface as
  // originSource = LIVE_BASE on the head row, and block_step20/21 mirror the
  // head planningDay/originSource for the Compiler.
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
  const todayLabel = new Date(nowSec * 1000).toISOString().slice(0, 10);

  rowsAway.forEach(function (row, idx) {
    const cols = row.split("|");
    if (cols.length < 21) fail('stale-away row ' + idx + ' expected >= 21 columns (Slice A), got ' + cols.length);
    if (!DAY_RE.test(cols[19] || '')) {
      fail('stale-away row ' + idx + ' col 20 planningDay must be YYYY-MM-DD, got ' + JSON.stringify(cols[19]));
    }
    if (SCH3_ORIGIN_SOURCES.indexOf(cols[20]) === -1) {
      fail('stale-away row ' + idx + ' col 21 originSource must be in SCH-3 enum, got ' + JSON.stringify(cols[20]));
    }
  });

  const headAwayCols = headAway;
  if (headAwayCols[19] !== todayLabel) {
    fail('stale-away head planningDay should be ' + todayLabel + ', got ' + JSON.stringify(headAwayCols[19]));
  }
  if (headAwayCols[20] !== "LIVE_BASE") {
    fail('stale-away head originSource should be LIVE_BASE, got ' + JSON.stringify(headAwayCols[20]));
  }

  const eodCols = eodReturnRow.split("|");
  if (eodCols[19] !== todayLabel) {
    fail('EOD_RETURN planningDay should be ' + todayLabel + ', got ' + JSON.stringify(eodCols[19]));
  }
  if (eodCols[20] !== "CONFIRMED_LAST_DESTINATION") {
    fail('EOD_RETURN originSource should be CONFIRMED_LAST_DESTINATION, got ' + JSON.stringify(eodCols[20]));
  }

  if (storeAway.locals['block_step20'] !== todayLabel) {
    fail('stale-away block_step20 should be ' + todayLabel + ', got ' + JSON.stringify(storeAway.locals['block_step20']));
  }
  if (storeAway.locals['block_step21'] !== "LIVE_BASE") {
    fail('stale-away block_step21 should be LIVE_BASE, got ' + JSON.stringify(storeAway.locals['block_step21']));
  }

  // INV-0.7 (C1): the Sandbox exports positive route metrics for the head leg
  // as block_step17 (route duration seconds) / block_step18 (route distance
  // miles), and the head queue row carries them in columns 17/18. Zero is never
  // exported — the Compiler rejects missing metrics instead.
  const headMetricDur = parseInt(headAwayCols[16], 10);
  const headMetricDist = parseFloat(headAwayCols[17]);
  if (isNaN(headMetricDur) || headMetricDur <= 0) {
    fail('stale-away head col 17 (durationSecs) should be positive, got ' + JSON.stringify(headAwayCols[16]));
  }
  if (isNaN(headMetricDist) || headMetricDist <= 0) {
    fail('stale-away head col 18 (distanceMiles) should be positive, got ' + JSON.stringify(headAwayCols[17]));
  }
  const blockStep17 = parseInt(storeAway.locals['block_step17'], 10);
  const blockStep18 = parseFloat(storeAway.locals['block_step18']);
  if (isNaN(blockStep17) || blockStep17 <= 0) {
    fail('stale-away block_step17 should be a positive route duration (seconds), got ' + JSON.stringify(storeAway.locals['block_step17']));
  }
  if (isNaN(blockStep18) || blockStep18 <= 0) {
    fail('stale-away block_step18 should be a positive route distance (miles), got ' + JSON.stringify(storeAway.locals['block_step18']));
  }
  if (blockStep17 !== headMetricDur) fail('stale-away block_step17 should mirror head col 17');
  if (blockStep18 !== headMetricDist) fail('stale-away block_step18 should mirror head col 18');

  console.log('PASS: AC-6 Sandbox: stale-away itinerary loses to live base; future trip JIT');
  console.log('  control: head policy = ' + headHome[18]);
  console.log('  stale-away: queue identical to control (origin rebound to home), head policy = ' + headPolicy);
  console.log('  block_step19 = ' + blockStep19);
  console.log('  all ' + rowsAway.length + ' stale-away queue rows carry an explicit ASAP/JIT policy');
  console.log('  head planningDay = ' + headAwayCols[19] + ', originSource = ' + headAwayCols[20] + ', block_step20/21 mirrored');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
