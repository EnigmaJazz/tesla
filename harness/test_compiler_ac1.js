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
    block_step20: "2026-10-24",
    block_step21: "LIVE_BASE",
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

// Phase 2: Compiler no longer writes the live Itin_Master.json directly.
// It publishes through Generation_Publisher, so read the committed generation
// from the manifest.
function readActiveItinerary(store) {
  const manifestRaw = store.files['Tasker/Tesla/Data/TDS_Run_Manifest.json'];
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw);
  const itinRaw = store.files[manifest.itineraryPath];
  if (!itinRaw) return null;
  return JSON.parse(itinRaw);
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

  const asapItin = readActiveItinerary(asapStore);
  if (!asapItin) fail('ASAP: published itinerary was not found');
  if (asapItin.length !== 2) fail('ASAP: expected 2 legs, got ' + asapItin.length);
  const asapHead = asapItin[1];
  assert.equal(asapHead.departurePolicy, 'ASAP', 'ASAP: published leg should carry departurePolicy ASAP');
  assert.equal(asapHead.departUnix, expectedHardFloor, 'ASAP: departUnix should equal hardFloor');
  assert.equal(asapHead.planningDay, '2026-10-24', 'ASAP: published leg should carry planningDay from block_step20');
  assert.equal(asapHead.originSource, 'LIVE_BASE', 'ASAP: published leg should carry originSource from block_step21');

  // Sub-test: JIT.
  const jitStore = runWithPolicy("JIT");
  if (jitStore.runError) fail('JIT script threw: ' + jitStore.runError.message + ' (line ' + jitStore.runError.line + ')');

  const jitFallback = jitStore.flashLog.some(function (m) {
    return m.indexOf('DEPARTURE_POLICY_FALLBACK_USED') !== -1;
  });
  if (jitFallback) fail('JIT: unexpected DEPARTURE_POLICY_FALLBACK_USED flash');

  const jitItin = readActiveItinerary(jitStore);
  if (!jitItin) fail('JIT: published itinerary was not found');
  if (jitItin.length !== 2) fail('JIT: expected 2 legs, got ' + jitItin.length);
  const jitHead = jitItin[1];
  assert.equal(jitHead.departurePolicy, 'JIT', 'JIT: published leg should carry departurePolicy JIT');
  assert.equal(jitHead.departUnix, Math.max(expectedHardFloor, expectedDepTarget), 'JIT: departUnix should equal Math.max(hardFloor, depTarget)');

  // Cross-test: the legacy handled previous leg must not silently force ASAP.
  // The JIT run already proved this; assert it explicitly.
  if (jitHead.departUnix === expectedHardFloor && expectedHardFloor > Math.max(expectedHardFloor, expectedDepTarget)) {
    fail('JIT: legacy handled pitstopState forced ASAP departure');
  }

  // INV-0.7 (C1): metric fallback tiers. Tier order is validated API metrics,
  // then positive Sandbox metrics (block_step17 duration secs / block_step18
  // distance miles), then a local haversine estimate for ACTIVE_TRAVEL only,
  // else the leg is rejected as zero-duration. Every fallback logs
  // DEPARTURE_POLICY_FALLBACK_USED with {from,to,durationSecs,distanceMiles}.
  function runWithMetrics(overrides) {
    const base = {
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
      block_step19: "JIT",
      block_step20: "2026-10-24",
      block_step21: "LIVE_BASE",
      api_duration_secs: "",
      api_distance_miles: "",
      api_transit_steps: "",
      virtual_time: String(nowSec - 60)
    };
    const locals = Object.assign({}, base, overrides);
    const { sandbox, store } = createSandbox({
      locals: locals,
      globals: {
        User_At_Base: "true",
        User_Loc: homeCoords,
        Arrival_Buffer_Mins: "5",
        Departure_Buffer_Mins: "5"
      },
      files: {
        "Tasker/Tesla/Data/TDS_Master.json": masterJson,
        "Tasker/Tesla/Data/Itin_Master.json": itinJson,
        "Tasker/Tesla/Data/TDS_Overrides.json": "{}"
      },
      nowMs: nowSec * 1000
    });
    runScript(path.resolve(__dirname, '..', 'Compiler.js'), sandbox, store);
    return store;
  }

  function findFallbackFlash(store, from, to) {
    return store.flashLog.find(function (m) {
      if (m.indexOf('DEPARTURE_POLICY_FALLBACK_USED') === -1) return false;
      try {
        const o = JSON.parse(m);
        return o.details && o.details.from === from && o.details.to === to;
      } catch (e) { return false; }
    });
  }

  // Sub-test: invalid API metrics + positive Sandbox metrics (columns 17-18).
  // The Compiler must consume block_step17/18 BEFORE any local estimation and
  // publish a positive duration, logging the API -> SANDBOX fallback.
  const sbStore = runWithMetrics({ block_step17: "2400", block_step18: "12.5" });
  if (sbStore.runError) fail('Sandbox-metrics fixture threw: ' + sbStore.runError.message);
  const sbItin = readActiveItinerary(sbStore);
  if (!sbItin) fail('Sandbox-metrics: published itinerary was not found');
  if (sbItin.length !== 2) fail('Sandbox-metrics: expected 2 legs (stale + head), got ' + sbItin.length);
  const sbHead = sbItin[1];
  assert.equal(sbHead.durationSecs, 2400, 'Sandbox-metrics: published leg should carry the Sandbox route duration');
  assert.equal(sbHead.distanceMiles, 12.5, 'Sandbox-metrics: published leg should carry the Sandbox route distance');
  assert.equal(sbHead.departurePolicy, 'JIT', 'Sandbox-metrics: published leg should carry explicit departurePolicy (col 19)');
  const sbFlash = findFallbackFlash(sbStore, "API", "SANDBOX");
  if (!sbFlash) fail('Sandbox-metrics: expected DEPARTURE_POLICY_FALLBACK_USED {from:API,to:SANDBOX}');
  const sbFlashObj = JSON.parse(sbFlash);
  assert.equal(sbFlashObj.details.durationSecs, 2400, 'fallback flash should carry the Sandbox durationSecs');
  assert.equal(sbFlashObj.details.distanceMiles, 12.5, 'fallback flash should carry the Sandbox distanceMiles');

  // Sub-test: no API metrics, no Sandbox metrics, ACTIVE_TRAVEL -> local
  // haversine estimate publishes a positive duration.
  const atStore = runWithMetrics({ block_step8: "ACTIVE_TRAVEL" });
  if (atStore.runError) fail('ACTIVE_TRAVEL fixture threw: ' + atStore.runError.message);
  const atItin = readActiveItinerary(atStore);
  if (!atItin) fail('ACTIVE_TRAVEL: published itinerary was not found');
  if (atItin.length !== 2) fail('ACTIVE_TRAVEL: expected 2 legs (stale + head), got ' + atItin.length);
  const atHead = atItin[1];
  if (!(atHead.durationSecs > 0)) fail('ACTIVE_TRAVEL: local estimate must publish a positive duration, got ' + atHead.durationSecs);
  if (!(atHead.distanceMiles > 0)) fail('ACTIVE_TRAVEL: local estimate must publish positive distance, got ' + atHead.distanceMiles);
  const atFlash = findFallbackFlash(atStore, "SANDBOX", "LOCAL_ESTIMATE");
  if (!atFlash) fail('ACTIVE_TRAVEL: expected DEPARTURE_POLICY_FALLBACK_USED {from:SANDBOX,to:LOCAL_ESTIMATE}');

  // Sub-test (verify run 2): SHORT-distance ACTIVE_TRAVEL local estimate must
  // not round distance to 0.0 and publish an incomplete pair. A ~10 m walk
  // (distance ≈ 0.006 mi) must publish with BOTH metrics positive.
  const shortCoords = "51.9001,-2.1001"; // ~10 m from homeCoords
  const shortStore = runWithMetrics({ block_step8: "ACTIVE_TRAVEL", block_step3: shortCoords });
  if (shortStore.runError) fail('short-distance fixture threw: ' + shortStore.runError.message);
  const shortItin = readActiveItinerary(shortStore);
  if (!shortItin) fail('short-distance: published itinerary was not found');
  if (shortItin.length !== 2) fail('short-distance: expected 2 legs (stale + head), got ' + shortItin.length);
  const shortHead = shortItin[1];
  if (!(shortHead.durationSecs > 0)) fail('short-distance: duration must be positive, got ' + shortHead.durationSecs);
  if (!(shortHead.distanceMiles > 0)) fail('short-distance: distance must stay positive after rounding, got ' + shortHead.distanceMiles);

  // Sub-test: every tier fails (DEPART with no metrics) -> the leg is rejected
  // with ZERO_DURATION_LEG_REJECTED and never publishes.
  const zdStore = runWithMetrics({});
  if (zdStore.runError) fail('zero-duration fixture threw: ' + zdStore.runError.message);
  const zdFlash = zdStore.flashLog.find(function (m) { return m.indexOf('ZERO_DURATION_LEG_REJECTED') !== -1; });
  if (!zdFlash) fail('zero-duration: expected ZERO_DURATION_LEG_REJECTED flash');
  assert.equal(JSON.parse(zdFlash).tripId, 'abc123_kx8f00', 'zero-duration rejection should identify the trip');
  const zdItin = readActiveItinerary(zdStore);
  if (!zdItin) fail('zero-duration: published itinerary was not found');
  if (zdItin.length !== 1) fail('zero-duration: rejected leg must not publish (expected only the stale leg, 1), got ' + zdItin.length);

  // Sub-test (verify fix): PARTIAL API pair {duration: 1800, distance: 0} with
  // no later tier must NOT publish with distanceMiles 0. The incomplete pair is
  // rejected as zero-duration (INV-0.7 complete-metric contract).
  const partialStore = runWithMetrics({ api_duration_secs: "1800", api_distance_miles: "0" });
  if (partialStore.runError) fail('partial-pair fixture threw: ' + partialStore.runError.message);
  const partialFlash = partialStore.flashLog.find(function (m) { return m.indexOf('ZERO_DURATION_LEG_REJECTED') !== -1; });
  if (!partialFlash) fail('partial-pair: expected ZERO_DURATION_LEG_REJECTED flash for incomplete metric pair');
  const partialItin = readActiveItinerary(partialStore);
  if (!partialItin) fail('partial-pair: published itinerary was not found');
  if (partialItin.length !== 1) fail('partial-pair: incomplete-metric leg must not publish (expected only the stale leg, 1), got ' + partialItin.length);

  // Sub-test: PARTIAL pair WITH a valid Sandbox tier must use the Sandbox
  // metrics (fallback, not rejection) — the pair is only rejected when every
  // later tier also fails.
  const partialSbStore = runWithMetrics({ api_duration_secs: "1800", api_distance_miles: "0", block_step17: "2400", block_step18: "12.5" });
  if (partialSbStore.runError) fail('partial-pair+sandbox fixture threw: ' + partialSbStore.runError.message);
  const partialSbItin = readActiveItinerary(partialSbStore);
  if (!partialSbItin) fail('partial-pair+sandbox: published itinerary was not found');
  if (partialSbItin.length !== 2) fail('partial-pair+sandbox: expected 2 legs (stale + head), got ' + partialSbItin.length);
  const partialSbHead = partialSbItin[1];
  assert.equal(partialSbHead.durationSecs, 2400, 'partial-pair+sandbox: should consume the Sandbox duration');
  assert.equal(partialSbHead.distanceMiles, 12.5, 'partial-pair+sandbox: should consume the Sandbox distance');

  console.log('PASS: AC-1 Compiler: explicit departurePolicy consumed; isPrevBase reconstruction removed');
  console.log('  ASAP departUnix = ' + asapHead.departUnix + ' (hardFloor = ' + expectedHardFloor + ')');
  console.log('  JIT  departUnix = ' + jitHead.departUnix + ' (max = ' + Math.max(expectedHardFloor, expectedDepTarget) + ', depTarget = ' + expectedDepTarget + ')');
  console.log('  no DEPARTURE_POLICY_FALLBACK_USED flash in either sub-test');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
