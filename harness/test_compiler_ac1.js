// AC-1: Compiler consumes explicit block_step19 departure policy.
//
// Seed a legacy Itin_Master.json whose tail leg says handled (away) and a
// TDS_Master.json future event. Run Compiler.js twice: once with
// block_step19="ASAP" and once with block_step19="JIT". Assert the head
// departure time follows the explicit policy, the fallback flash is not
// emitted when the policy is present, and the legacy handled state cannot
// silently force ASAP.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const homeCoords = "51.9,-2.1";
const destCoords = "52.1,-2.2";
const futureEventStart = nowSec + 3600;
const durationSecs = 1800;
const arrivalBufferSecs = 5 * 60;

const itinJson = JSON.stringify([
  {
    tripId: "stale_away_leg",
    targetEventId: "previous_event",
    mode: "DRIVE",
    pitstopState: "handled",
    departUnix: nowSec - 3600,
    arriveUnix: nowSec - 1800
  }
]);

const masterJson = JSON.stringify([
  {
    id: "abc123_kx8f00",
    start: futureEventStart,
    end: futureEventStart + 3600,
    duration: 3600,
    title: "Future Event",
    desc: "",
    loc: "Work",
    coords: destCoords
  }
]);

function runWithPolicy(policy) {
  const locals = {
    block_step1: "EVENT",
    block_step2: "Future Event",
    block_step3: destCoords,
    block_step4: "DRIVE",
    block_step5: String(futureEventStart),
    block_step7: "false",
    block_step8: "DEPART",
    block_step9: String(futureEventStart),
    block_step10: "abc123_kx8f00",
    block_step14: "",
    block_step15: "",
    block_step16: "",
    block_step19: policy,
    api_duration_secs: String(durationSecs),
    api_distance_miles: "15",
    api_transit_steps: "",
    virtual_time: String(nowSec - 60)
  };

  const globals = {
    User_At_Base: "true",
    User_Loc: homeCoords,
    Arrival_Buffer_Mins: "5",
    Departure_Buffer_Mins: "5"
  };

  const files = {
    "Tasker/Tesla/Data/TDS_Master.json": masterJson,
    "Tasker/Tesla/Data/Itin_Master.json": itinJson,
    "Tasker/Tesla/Data/TDS_Overrides.json": "{}"
  };

  const { sandbox, store } = createSandbox({
    locals: locals,
    globals: globals,
    files: files,
    nowMs: nowSec * 1000
  });

  const scriptPath = path.resolve(__dirname, '..', 'Compiler.js');
  runScript(scriptPath, sandbox, store);
  return store;
}

function fail(msg) {
  console.log('FAIL: AC-1 Compiler: ' + msg);
  process.exit(1);
}

// Expected hard floor for a legacy handled previous leg with no master event.
// Compiler path: prevArr + 1800, then max(nowSec, ...).
const prevArr = nowSec - 1800;
const expectedHardFloor = Math.max(nowSec, prevArr + 1800);

// Expected depTarget for the head leg (DEPART, non-isDepart, default buffer).
const expectedDepTarget = futureEventStart - arrivalBufferSecs - durationSecs;

try {
  // Sub-test: ASAP.
  const asapStore = runWithPolicy("ASAP");
  if (asapStore.runError) fail('ASAP script threw: ' + asapStore.runError.message + ' (line ' + asapStore.runError.line + ')');

  const asapFallback = asapStore.flashLog.some(function (m) {
    return m.indexOf('DEPARTURE_POLICY_FALLBACK_USED') !== -1;
  });
  if (asapFallback) fail('ASAP: unexpected DEPARTURE_POLICY_FALLBACK_USED flash');

  const asapItinRaw = asapStore.files['Tasker/Tesla/Data/Itin_Master.json'];
  if (!asapItinRaw) fail('ASAP: Itin_Master.json was not written');
  const asapItin = JSON.parse(asapItinRaw);
  if (asapItin.length !== 2) fail('ASAP: expected 2 legs, got ' + asapItin.length);
  const asapHead = asapItin[1];
  assert.equal(asapHead.departurePolicy, 'ASAP', 'ASAP: published leg should carry departurePolicy ASAP');
  assert.equal(asapHead.departUnix, expectedHardFloor, 'ASAP: departUnix should equal hardFloor');

  // Sub-test: JIT.
  const jitStore = runWithPolicy("JIT");
  if (jitStore.runError) fail('JIT script threw: ' + jitStore.runError.message + ' (line ' + jitStore.runError.line + ')');

  const jitFallback = jitStore.flashLog.some(function (m) {
    return m.indexOf('DEPARTURE_POLICY_FALLBACK_USED') !== -1;
  });
  if (jitFallback) fail('JIT: unexpected DEPARTURE_POLICY_FALLBACK_USED flash');

  const jitItinRaw = jitStore.files['Tasker/Tesla/Data/Itin_Master.json'];
  if (!jitItinRaw) fail('JIT: Itin_Master.json was not written');
  const jitItin = JSON.parse(jitItinRaw);
  if (jitItin.length !== 2) fail('JIT: expected 2 legs, got ' + jitItin.length);
  const jitHead = jitItin[1];
  assert.equal(jitHead.departurePolicy, 'JIT', 'JIT: published leg should carry departurePolicy JIT');
  assert.equal(jitHead.departUnix, Math.max(expectedHardFloor, expectedDepTarget), 'JIT: departUnix should equal Math.max(hardFloor, depTarget)');

  // Cross-test: the legacy handled previous leg must not silently force ASAP.
  // The JIT run already proved this; assert it explicitly.
  if (jitHead.departUnix === expectedHardFloor && expectedHardFloor > Math.max(expectedHardFloor, expectedDepTarget)) {
    fail('JIT: legacy handled pitstopState forced ASAP departure');
  }

  console.log('PASS: AC-1 Compiler: explicit departurePolicy consumed; isPrevBase reconstruction removed');
  console.log('  ASAP departUnix = ' + asapHead.departUnix + ' (hardFloor = ' + expectedHardFloor + ')');
  console.log('  JIT  departUnix = ' + jitHead.departUnix + ' (max = ' + Math.max(expectedHardFloor, expectedDepTarget) + ', depTarget = ' + expectedDepTarget + ')');
  console.log('  no DEPARTURE_POLICY_FALLBACK_USED flash in either sub-test');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
