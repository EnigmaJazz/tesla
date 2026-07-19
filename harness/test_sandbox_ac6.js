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
    const last = cols[cols.length - 1];
    if (last !== "ASAP" && last !== "JIT") {
      throw new Error(label + ' row ' + idx + ' missing explicit ASAP/JIT policy (got ' + JSON.stringify(last) + ')');
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
  if (headHome[headHome.length - 1] !== "JIT") fail('control head policy should be JIT, got ' + headHome[headHome.length - 1]);
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

  const headPolicy = headAway[headAway.length - 1];
  if (headPolicy !== "JIT") fail('stale-away head policy should be JIT, got ' + headPolicy);

  const blockStep19 = storeAway.locals['block_step19'];
  if (blockStep19 !== "JIT") fail('stale-away block_step19 should be JIT, got ' + blockStep19);

  assertRowsHavePolicy(rowsAway, 'stale-away');

  console.log('PASS: AC-6 Sandbox: stale-away itinerary loses to live base; future trip JIT');
  console.log('  control: head policy = ' + headHome[headHome.length - 1]);
  console.log('  stale-away: queue identical to control (origin rebound to home), head policy = ' + headPolicy);
  console.log('  block_step19 = ' + blockStep19);
  console.log('  all ' + rowsAway.length + ' stale-away queue rows carry an explicit ASAP/JIT policy');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
