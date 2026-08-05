// AC-8: Stop duration detail.
// A leg with pendingStopsRaw="5,10" must NOT have stop padding added to
// its durationSecs, and the following leg's depTarget must advance by
// exactly 15 minutes, not 30.
//
// Strategy: pre-populate Pending_Compiler.json with a "leg 1" entry
// whose pendingStopsRaw="5,10" and stopPadSecs=900, then run the
// compiler once for a "leg 2" entry with no stops. The script pushes
// the new event into pendingChain, flushes the chain, and writes both
// legs into Itin_Master.json. We assert that the published durationSecs
// is the route-only value (1800, not 2700) and the gap from leg 1's
// arriveUnix to leg 2's departUnix is 900 seconds (15 min), not 1800
// (30 min).

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const leg2Start = nowSec + 3600;

const masterJson = JSON.stringify([
  { id: "leg2_id", start: leg2Start, duration: 0, end: leg2Start + 3600, title: "Leg2", desc: "" }
]);

const pendingJson = JSON.stringify([
  {
    targetEventId: "leg1_id",
    targetTitle: "Leg1",
    targetDesc: "",
    targetCoords: "52.0,-2.0",
    mode: "DRIVE",
    durationSecs: 1800,
    distanceMiles: 15,
    pitstopState: "false",
    evStartSecs: nowSec,
    isDepart: false,
    transitStepsRaw: "",
    pendingStopsRaw: "5,10",
    isAttachedDropin: false,
    dropinDur: 0,
    stopPadSecs: 900,
    stopUiStr: "5m, 10m",
    apiType: "DEPART",
    actionType: "EVENT",
    apiUnix: nowSec
  }
]);

const locals = {
  block_queue: makeEnvelope([makeTypedRow({
    rowType: "EVENT",
    title: "Leg2",
    coords: "52.1,-2.2",
    mode: "DRIVE",
    displayTime: leg2Start,
    departTime: leg2Start,
    pitstopState: "false",
    apiTimeType: "DEPART",
    apiTimeUnix: leg2Start,
    evId: "leg2_id",
    evLoc: "Work",
    engineLateMins: 0,
    currentLegStable: false,
    dropinStatusFlag: "none",
    safeDesc: "",
    adHoc: [],
    departurePolicy: "JIT",
    planningDay: new Date(leg2Start * 1000).toISOString().slice(0, 10),
    originSource: "LIVE_BASE"
  })]),
  api_duration_secs: "1800",
  api_distance_miles: "15",
  api_transit_steps: "",
  virtual_time: String(nowSec - 60)
};

const globals = {
  User_At_Base: "true",
  User_Loc: "51.9,-2.1",
  Arrival_Buffer_Mins: "5",
  Departure_Buffer_Mins: "5"
};

const files = {
  "Tasker/Tesla/Data/TDS_Master.json": masterJson,
  "Tasker/Tesla/Data/Pending_Compiler.json": pendingJson,
  "Tasker/Tesla/Data/Itin_Master.json": "[]"
};

const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
const scriptPath = path.resolve(__dirname, '..', 'Compiler.js');
runScript(scriptPath, sandbox, store);

// Phase 2: Compiler publishes through Generation_Publisher. Read the committed
// generation from the manifest instead of the live Itin_Master.json.
function readActiveItinerary(store) {
  const manifestRaw = store.files['Tasker/Tesla/Data/TDS_Run_Manifest.json'];
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw);
  const itinRaw = store.files[manifest.itineraryPath];
  if (!itinRaw) return null;
  return JSON.parse(itinRaw);
}

const testName = 'AC-8 Compiler: stop padding applied once (5,10 = 15 min, not 30)';

function fail(msg) {
  console.log('FAIL: ' + testName + ' — ' + msg);
  process.exit(1);
}

try {
  if (store.runError) fail('script threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  const itin = readActiveItinerary(store);
  if (!itin) fail('published itinerary was not found');
  if (itin.length !== 2) fail('expected 2 legs in Itin_Master, got ' + itin.length);

  const leg1 = itin[0];
  const leg2 = itin[1];

  // durationSecs must be the route-only value, never route+stops.
  assert.equal(leg1.durationSecs, 1800, 'leg 1 durationSecs should be 1800 (route-only)');
  if (leg1.durationSecs >= 1800 + 900) fail('leg 1 durationSecs (' + leg1.durationSecs + ') includes stop padding (would be >= 2700)');

  // pendingStopsRaw is preserved on the published leg.
  assert.equal(leg1.pendingStopsRaw, '5,10', 'leg 1 pendingStopsRaw should be preserved as "5,10"');

  // The following leg's depTarget must advance by exactly 900s, not 1800s.
  const gap = leg2.departUnix - leg1.arriveUnix;
  assert.equal(gap, 900, 'leg 1 -> leg 2 gap should be 900s (15 min), got ' + gap);
  if (gap >= 1800) fail('leg 1 -> leg 2 gap (' + gap + 's) is the 30-min bug, not the 15-min fix');

  console.log('PASS: ' + testName);
  console.log('  leg1.durationSecs = ' + leg1.durationSecs);
  console.log('  leg1.arriveUnix   = ' + leg1.arriveUnix);
  console.log('  leg2.departUnix   = ' + leg2.departUnix);
  console.log('  gap               = ' + gap + 's');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
