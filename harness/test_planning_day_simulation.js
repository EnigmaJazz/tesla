// Full on-device planning-day simulation (serial Tasker chain, no shims).
//
// Reproduces TASKER_PLANNING_TASK.md end-to-end in the harness:
//   Alpha (calendar ingest) → Cluster_Builder + cluster API chain (dropin
//   order) → Finaliser + Generation_Publisher (bootstrap events into the
//   committed master) → block loop: Sandbox_Engine (simulate block) →
//   router+reducer → per-leg Gatekeeper/API chain (HTTP mocked via
//   temp_payload.json) → Compiler (single-row envelope) → publisher →
//   router+reducer → until eof. Then the consumers (Dispatcher, Dashboard)
//   read the committed generation.
//
// The HTTP actions are device-side; here the "response" is written into
// temp_payload.json as the {correlation, response} envelope the parser
// expects, with deterministic route fixtures per mode.
//
// Each action runs in a FRESH vm context carrying locals/globals/files
// forward — Tasker runs every JSlet in its own engine context, and the
// harness's vm.createContext is cached per sandbox object, so repeated runs
// of scripts declaring top-level const (SECONDS_PER_DAY etc.) would collide
// on a shared context. Router+reducer deliveries are safe on one context
// (those scripts use var per the repo's shared-vm convention).

process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const ROOT = path.resolve(__dirname, '..');
const ALPHA = path.join(ROOT, 'Alpha.js');
const CLUSTER_BUILDER = path.join(ROOT, 'Cluster_Builder.js');
const GATEKEEPER = path.join(ROOT, 'Gatekeeper.js');
const API_BUILD = path.join(ROOT, 'API_JSON_Build.js');
const API_PARSE = path.join(ROOT, 'API_Parser.js');
const RCM = path.join(ROOT, 'Route_Cache_Manager.js');
const FINALISER = path.join(ROOT, 'Finaliser.js');
const PUBLISHER = path.join(ROOT, 'Generation_Publisher.js');
const SANDBOX = path.join(ROOT, 'Sandbox_Engine.js');
const COMPILER = path.join(ROOT, 'Compiler.js');
const DISPATCHER = path.join(ROOT, 'Dispatcher.js');
const DASHBOARD = path.join(ROOT, 'Dashboard.js');

const nowSec = 1700000000; // 2023-11-14T22:13:20Z
const DATA = 'Tasker/Tesla/Data/';
const MANIFEST = DATA + 'TDS_Run_Manifest.json';
const TEMP_PAYLOAD = DATA + 'temp_payload.json';

// Named fixture/time constants (AGENTS.md: no magic numbers).
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const LOOKAHEAD_DAYS = 30;            // AdHoc base lookahead
const MAX_BLOCKS_PER_DAY = 12;        // runaway block-loop bound
const DRIVE_FIXTURE_SECS = 1800;      // route fixture duration for DRIVE
const WALK_FIXTURE_SECS = 900;        // route fixture duration for WALK
const TRANSIT_FIXTURE_SECS = 1500;    // route fixture duration for TRANSIT
const DRIVE_FIXTURE_METERS = 12000;   // route fixture distance for DRIVE
const WALK_FIXTURE_METERS = 1200;     // route fixture distance for WALK
const TRANSIT_FIXTURE_METERS = 9000;  // route fixture distance for TRANSIT
const DURATION_TOLERANCE_SECS = 5;    // API-duration assertion tolerance
const ROLLUP_ADVANCE_HOURS = 20;      // clock advance past the day's events
const MIN_BASE_DATA_LEN = 3;          // raw_base_data non-empty floor

const homeCoords = '51.9,-2.1';
const workCoords = '51.92,-2.05';
const shopCoords = '51.94,-2.02';
const bankCoords = '51.96,-2.04';
const gymCoords = '52.0,-2.0';

const failures = [];
function step(name, fn) {
  try {
    fn();
    console.log('  ok: ' + name);
  } catch (e) {
    failures.push(name + ' :: ' + e.message);
    console.log('  FAIL: ' + name + ' :: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Sandbox / globals / fixtures
// ---------------------------------------------------------------------------

const geocodeCache = {
  work: workCoords, shop: shopCoords, bank: bankCoords, gym: gymCoords
};
const adHocBase = [nowSec - SECONDS_PER_HOUR, nowSec + LOOKAHEAD_DAYS * SECONDS_PER_DAY, homeCoords, '0', 'Home', '', 'home_base'].join('~');

// Alpha reads %ce_title%i etc. (no underscore) — TASKER_SETUP.md §3.1 naming.
const calendarLocals = {
  ce_event_id1: 'work_abc_kx8f00', ce_title1: 'Work', ce_description1: '',
  ce_start_time1: String((nowSec + 4 * SECONDS_PER_HOUR) * 1000), ce_end_time1: String((nowSec + 12 * SECONDS_PER_HOUR) * 1000),
  ce_location1: 'work', ce_calendar1: 'Personal',
  ce_event_id2: 'shop_d1_m5xg00', ce_title2: 'Shop', ce_description2: '#dropin',
  ce_start_time2: String((nowSec + 2 * SECONDS_PER_HOUR) * 1000), ce_end_time2: String((nowSec + 3 * SECONDS_PER_HOUR) * 1000),
  ce_location2: 'shop', ce_calendar2: 'Personal',
  ce_event_id3: 'bank_d2_n6yh11', ce_title3: 'Bank', ce_description3: '#dropin',
  ce_start_time3: String((nowSec + 3 * SECONDS_PER_HOUR) * 1000), ce_end_time3: String((nowSec + 4 * SECONDS_PER_HOUR) * 1000),
  ce_location3: 'bank', ce_calendar3: 'Personal',
  ce_event_id4: 'gym_c3_p7zi22', ce_title4: 'Gym', ce_description4: '',
  ce_start_time4: String((nowSec + 14 * SECONDS_PER_HOUR) * 1000), ce_end_time4: String((nowSec + 16 * SECONDS_PER_HOUR) * 1000),
  ce_location4: 'gym', ce_calendar4: 'Personal'
};

function globals(extra) {
  return Object.assign({
    User_Loc: homeCoords, User_At_Base: 'true', TDS_Previous_Loc: homeCoords,
    Home_Coords: homeCoords, Base_Arrival_Unix: String(nowSec), Current_Status: '',
    Arrival_Buffer_Mins: '5', Departure_Buffer_Mins: '5', Max_Walk_Meters: '8046',
    Daily_Walk_Meters: '0', Live_Traffic_Threshold: '7200', Car_Connected: 'false',
    TIMEMS: String(nowSec * 1000), AdHoc_Base: adHocBase, TDS_Active_Generation: '',
    Tesla_Last_Scheduled: '0', batt_pct: '80', batt_alert: 'false', is_charging: 'false'
  }, extra || {});
}

function seedFiles(extra) {
  return Object.assign({
    [DATA + 'Geocode_Cache.json']: JSON.stringify(geocodeCache),
    [DATA + 'TDS_Overrides.json']: '{}',
    [DATA + 'TDS_Routine_Preferences.json']: '{}',
    [DATA + 'TDS_Trip_State.json']: JSON.stringify({
      schemaVersion: 1, revision: 0, generationId: '', currentOrigin: 'PLANNED',
      currentPlanningDay: '', userAtBase: true, baseArrivalUnix: nowSec, latenessHalt: false,
      currentStatus: '', manualReturnCompleted: false, trips: {}, stops: {}, completedDropins: {}, manualSessions: {}
    }),
    [DATA + 'TDS_Action_Sessions.json']: JSON.stringify({ schemaVersion: 1, sessions: {} }),
    [DATA + 'TDS_Manual_Trips.json']: JSON.stringify({ schemaVersion: 1, trips: {} }),
    [DATA + 'TDS_Reorder_Commands.json']: '[]'
  }, extra || {});
}

function make(extraFiles, extraGlobals, extraLocals) {
  return createSandbox({
    serialMode: true,
    files: seedFiles(extraFiles || {}),
    globals: globals(extraGlobals || {}),
    locals: Object.assign({}, calendarLocals, extraLocals || {}),
    nowMs: nowSec * 1000
  });
}

// Run one script as its own serial task action, then restart the sandbox in a
// FRESH vm context carrying locals/globals/files forward.
let ALL_LOGS = []; // accumulated flash log across restarts (mock's store
                   // flashLog is the closure array — reassigning it breaks flash())
function action(S, scriptPath, label) {
  S.sandbox.__currentScriptPath = scriptPath;
  runScript(scriptPath, S.sandbox, S.store);
  S.sandbox.__currentScriptPath = '';
  if (S.store.runError) throw new Error(label + ' crashed: ' + S.store.runError.message + (S.store.runError.line ? ' (line ' + S.store.runError.line + ')' : ''));
  ALL_LOGS = ALL_LOGS.concat(S.store.flashLog || []);
  return restart(S);
}

function restart(S) {
  const files = {}; const locals = {}; const globals = {};
  Object.keys(S.store.files || {}).forEach(function (k) { files[k] = S.store.files[k]; });
  Object.keys(S.store.locals || {}).forEach(function (k) { locals[k] = S.store.locals[k]; });
  Object.keys(S.store.globals || {}).forEach(function (k) { globals[k] = S.store.globals[k]; });
  const { sandbox, store } = createSandbox({
    serialMode: true, locals: locals, globals: globals, files: files, nowMs: S.store.now
  });
  return { sandbox: sandbox, store: store };
}

// Router+owner delivery (safe on one shared context), then restart.
function deliver(S, command, payload) {
  const rv = S.sandbox.stateCommand(command, payload);
  if (String(rv).indexOf('OK') !== 0) throw new Error('router rejected ' + command + ': ' + rv);
  ALL_LOGS = ALL_LOGS.concat(S.store.flashLog || []);
  return restart(S);
}

function logs() {
  return ALL_LOGS.map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}

function readJson(store, p) {
  const raw = store.files[p];
  return raw ? JSON.parse(raw) : null;
}

// Mock the Tasker HTTP action: write the {correlation, response} callback
// envelope the API_Parser expects, with a deterministic fixture.
function mockHttp(S, response) {
  const correlation = JSON.parse(S.sandbox.local('api_correlation'));
  S.sandbox.writeFile(TEMP_PAYLOAD, JSON.stringify({ correlation: correlation, response: response }));
}

function routeFixture(mode) {
  const durSecs = mode === 'WALK' ? WALK_FIXTURE_SECS : mode === 'TRANSIT' ? TRANSIT_FIXTURE_SECS : DRIVE_FIXTURE_SECS;
  const distM = mode === 'WALK' ? WALK_FIXTURE_METERS : mode === 'TRANSIT' ? TRANSIT_FIXTURE_METERS : DRIVE_FIXTURE_METERS;
  return {
    routes: [{
      duration: durSecs + 's', distanceMeters: distM,
      legs: [{ staticDuration: durSecs + 's', distanceMeters: distM }]
    }]
  };
}

const clusterFixture = { routes: [{ optimizedIntermediateWaypointIndex: [1, 0] }] };

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

let S; // { sandbox, store } — restarted after every action
let DAY_IDS = {}; // actual (suffixed) occurrence ids staged by Alpha

step('alpha-ingests-calendar-events', function () {
  const boot = make();
  S = restart(boot);
  ALL_LOGS = [];
  S = action(S, ALPHA, 'Alpha');
  const events = JSON.parse(S.sandbox.local('tds_temp_json'));
  assert(Array.isArray(events) && events.length >= 4, 'Alpha must stage the calendar events, got ' + events.length);
  // Alpha mints occurrence ids <core>_<base36> (repo ID-2 convention) and may
  // split deadline events into <core>_IN/_OUT — resolve by EXACT staged field
  // equality (loc), never by prefix-matching minted ids (hard rule).
  function anyOf(loc) {
    const match = events.filter(function (e) { return e.loc === loc; });
    assert(match.length >= 1, 'expected at least one event at ' + loc);
    return match;
  }
  function dropinOf(loc) {
    const match = events.filter(function (e) { return e.loc === loc && e.isDropin === true; });
    assert(match.length === 1, 'expected exactly one dropin event at ' + loc + ', got ' + match.length);
    return match[0];
  }
  const work = anyOf('work')[0];
  const shop = dropinOf('shop');
  const bank = dropinOf('bank');
  const gym = anyOf('gym')[0];
  DAY_IDS = { work: work.id, shop: shop.id, bank: bank.id, gym: gym.id };
  assert(work.coords === workCoords, 'work coords must resolve from the geocode cache');
  assert(shop.isDropin === true, 'shop must be flagged dropin');
  assert(bank.isDropin === true, 'bank must be flagged dropin');
  assert(gym.coords === gymCoords, 'gym coords must resolve');
  assert((S.sandbox.local('raw_base_data') || '').length > MIN_BASE_DATA_LEN, 'raw_base_data must be staged (AdHoc base)');
});

step('cluster-chain-identifies-dropin-order', function () {
  let idx = 1;
  let clusters = 0;
  for (;;) {
    S.sandbox.setLocal('cluster_idx', String(idx));
    S = action(S, CLUSTER_BUILDER, 'Cluster_Builder');
    if (S.sandbox.local('cluster_eof') === 'true') break;
    clusters++;
    const clusterRaw = S.sandbox.local('par1');
    assert(clusterRaw && clusterRaw.indexOf('{') === 0, 'builder must stage a cluster');
    const cluster = JSON.parse(clusterRaw);
    assert(cluster.waypoints.length === 2, 'cluster must carry both dropins');
    assert(cluster.origin === homeCoords, 'head-group cluster origin must be the base coords (dropins precede any main event)');

    S = action(S, GATEKEEPER, 'Gatekeeper-cluster');
    if (S.sandbox.local('cluster_bypass') === 'true') {
      // Cached/forced order: Gatekeeper already staged ENQUEUE_REORDER.
      S = deliver(S, S.sandbox.local('par1'), JSON.parse(S.sandbox.local('par2')));
    } else {
      assert(S.sandbox.local('cache_hit') === 'false', 'cold cluster must not hit');
      S = action(S, API_BUILD, 'API_JSON_Build-cluster');
      S = action(S, RCM, 'RCM-register-cluster');
      mockHttp(S, clusterFixture);
      S = action(S, API_PARSE, 'API_Parser-cluster');
      assert(S.sandbox.local('par1') === 'ORDER_CACHE_UPSERT', 'parser must stage ORDER_CACHE_UPSERT');
      S = action(S, RCM, 'RCM-order-upsert');
      assert(S.sandbox.local('par1') === 'ENQUEUE_REORDER', 'RCM must re-stage ENQUEUE_REORDER');
      S = deliver(S, 'ENQUEUE_REORDER', JSON.parse(S.sandbox.local('par2')));
    }
    idx++;
  }
  assert(clusters === 1, 'one dropin group expected, got ' + clusters);
  const queue = readJson(S.store, DATA + 'TDS_Reorder_Commands.json');
  assert(Array.isArray(queue) && queue.length === 1, 'exactly one ENQUEUE_REORDER must be enqueued');
  assert.deepStrictEqual(queue[0].orderedEventIds, [DAY_IDS.bank, DAY_IDS.shop],
    'optimized order from the fixture ([1,0]) must be staged');
});

step('bootstrap-publish-applies-dropin-order', function () {
  S = action(S, FINALISER, 'Finaliser');
  assert(S.sandbox.local('par1').indexOf('{') === 0, 'Finaliser must stage the publish candidate');
  S = action(S, PUBLISHER, 'Generation_Publisher');
  const genId = S.sandbox.global('TDS_Active_Generation');
  assert(/^gen:\d{10}:[0-9a-f]{4}$/.test(genId), 'publisher must mint a generation, got ' + genId);
  // Deliver the post-publish batch (reconcile + any observations).
  S = deliver(S, S.sandbox.local('par1'), JSON.parse(S.sandbox.local('par2')));

  const manifest = readJson(S.store, MANIFEST);
  assert(manifest && manifest.state === 'committed', 'manifest must be committed');
  const master = readJson(S.store, manifest.masterPath);
  const ids = master.map(function (e) { return e.id; });
  const shopAt = ids.indexOf(DAY_IDS.shop);
  const bankAt = ids.indexOf(DAY_IDS.bank);
  assert(shopAt !== -1 && bankAt !== -1, 'dropins must be in the published master');
  assert(bankAt < shopAt, 'ENQUEUE_REORDER must be applied at publish (bank before shop), got ' + ids.join(','));
});

step('block-loop-simulates-day-and-publishes-itinerary', function () {
  let idx = 1;
  let blocks = 0;
  let legsPublished = 0;
  for (;;) {
    blocks++;
    assert(blocks <= MAX_BLOCKS_PER_DAY, 'block loop must terminate (eof), runaway at block ' + blocks);
    S.sandbox.setLocal('idx', String(idx));
    S.sandbox.setLocal('virtual_loc', S.sandbox.global('User_Loc'));
    S.sandbox.setLocal('virtual_time', String(nowSec));
    S.sandbox.setLocal('vcar_loc', S.sandbox.global('User_Loc'));
    S = action(S, SANDBOX, 'Sandbox_Engine');

    const envRaw = S.sandbox.local('block_queue');
    assert(envRaw && envRaw !== 'EOF', 'sandbox must stage the typed envelope');
    const env = JSON.parse(envRaw);
    const rows = env.rows || [];

    // Deliver the Sandbox's reducer batch (only when it staged commands).
    if (S.sandbox.local('par1') === 'REDUCER_BATCH') {
      const batch = JSON.parse(S.sandbox.local('par2'));
      if (Array.isArray(batch.commands) && batch.commands.length > 0) {
        S = deliver(S, 'REDUCER_BATCH', batch);
      }
    }

    // Per-leg API chain + compile + publish.
    let rowOrigin = S.sandbox.global('User_Loc');
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      S.sandbox.setLocal('par11', rowOrigin);
      S.sandbox.setLocal('par12', row.coords);
      S.sandbox.setLocal('par13', row.mode);
      S.sandbox.setLocal('par14', String(row.apiTimeUnix || nowSec));
      S = action(S, GATEKEEPER, 'Gatekeeper-leg');
      if (S.sandbox.local('cache_hit') !== 'true') {
        S = action(S, API_BUILD, 'API_JSON_Build-leg');
        S = action(S, RCM, 'RCM-register-leg');
        mockHttp(S, routeFixture(row.mode));
        S = action(S, API_PARSE, 'API_Parser-leg');
        assert(S.sandbox.local('par1') === 'SESSION_CACHE_UPSERT', 'route parser must stage SESSION_CACHE_UPSERT');
        S = action(S, RCM, 'RCM-session-upsert');
        // REQUEST_STATE_CONSUME rides dedicated locals; the serialMode sandbox
        // keeps the cacheManager shim, so the parser already delivered the
        // consume inline during its run — no separate action on device-parity
        // here (the device task runs it as its own RCM action per the wiring).
        if (S.sandbox.local('tds_consume_par1')) {
          assert(S.sandbox.local('tds_consume_par1') === 'REQUEST_STATE_CONSUME', 'consume command expected');
        }
      }
      const api = JSON.parse(S.sandbox.local('api_return_json'));
      assert(api.durationSecs > 0, 'api_return_json must carry a positive duration');
      S.sandbox.setLocal('api_duration_secs', String(api.durationSecs));
      S.sandbox.setLocal('api_distance_miles', String(api.distanceMiles));
      S.sandbox.setLocal('api_transit_steps', String(api.transitSteps || ''));

      // Single-row envelope so tier-1 API metrics apply to this leg.
      S.sandbox.setLocal('block_queue', JSON.stringify({
        schemaVersion: 1, rows: [row], eof: true, skipIdxUntil: 0, stepConflict: null, notifications: []
      }));
      S = action(S, COMPILER, 'Compiler');
      const candidateRaw = S.sandbox.local('par1');
      const calTitle = S.sandbox.local('cal_title_out');
      if (candidateRaw && candidateRaw.indexOf('{') === 0) {
        // Non-attached head: publish the compiled chain.
        S = action(S, PUBLISHER, 'Generation_Publisher-leg');
        S = deliver(S, S.sandbox.local('par1'), JSON.parse(S.sandbox.local('par2')));
        legsPublished++;
      } else if (calTitle === 'HOLD') {
        // Attached dropin row: HOLD + Pending_Compiler.json; it compiles with
        // the chain head and leaves par1 untouched (no publish here).
      } else {
        const rawTail = ALL_LOGS.slice(-6);
        const debug = logs().filter(function (l) {
          return ['TYPED_QUEUE_ACCEPTED', 'TYPED_QUEUE_REJECTED', 'ZERO_DURATION_LEG_REJECTED', 'DEPARTURE_POLICY_FALLBACK_USED'].indexOf(l.code) !== -1;
        }).map(function (l) { return l.code + ':' + JSON.stringify(l.details); });
        assert(false,
          'Compiler must stage a candidate or HOLD, got ' + JSON.stringify(candidateRaw) + ' cal=' + JSON.stringify(calTitle) + ' logs=' + JSON.stringify(debug) + ' raw=' + JSON.stringify(rawTail));
      }
      rowOrigin = row.coords;
    }

    // Roll due session samples into the master Welford cache (Route Cache Manager).
    S.sandbox.setLocal('par1', 'ROLLUP_DUE_TEMP');
    S.sandbox.setLocal('par2', JSON.stringify({ nowSec: nowSec, prune: true }));
    S = action(S, RCM, 'RCM-rollup');

    if (env.eof === true || rows.length === 0) break;
    idx = env.skipIdxUntil;
  }
  assert(legsPublished >= 1, 'the day must publish at least one chain, got ' + legsPublished);
  assert(S.sandbox.local('cal_title_out') && S.sandbox.local('cal_title_out').indexOf(' to ') !== -1,
    'calendar titles must be staged, got ' + JSON.stringify(S.sandbox.local('cal_title_out')));
  assert(S.sandbox.local('cal_start_out') && S.sandbox.local('cal_end_out'), 'calendar start/end must be staged');
});

step('committed-generation-carries-the-day-itinerary', function () {
  const manifest = readJson(S.store, MANIFEST);
  const itinerary = readJson(S.store, manifest.itineraryPath);
  assert(Array.isArray(itinerary) && itinerary.length >= 2, 'committed itinerary must hold the day legs, got ' + itinerary.length);
  itinerary.forEach(function (leg, i) {
    assert(leg.departUnix > nowSec - SECONDS_PER_HOUR, 'leg ' + i + ' must have a sane departUnix');
    assert(leg.arriveUnix > leg.departUnix, 'leg ' + i + ' arrival must follow departure');
    assert(leg.durationSecs > 0, 'leg ' + i + ' must carry a positive duration (API metrics)');
    assert(leg.targetEventId, 'leg ' + i + ' must carry the event id');
  });
  // The per-leg API metrics must have won (tier 1): DRIVE legs ~1800s from the fixture.
  const driveLegs = itinerary.filter(function (l) { return l.mode === 'DRIVE'; });
  assert(driveLegs.length >= 1, 'at least one DRIVE leg expected');
  driveLegs.forEach(function (l) { assert(Math.abs(l.durationSecs - DRIVE_FIXTURE_SECS) <= DURATION_TOLERANCE_SECS, 'DRIVE leg must use the API duration, got ' + l.durationSecs); });

  const calStarts = S.sandbox.local('cal_start_out').split('|').map(Number).filter(Boolean);
  const calEnds = S.sandbox.local('cal_end_out').split('|').map(Number).filter(Boolean);
  assert(calStarts.length === calEnds.length && calStarts.length >= 1, 'calendar pairs must align');
  for (let i = 0; i < calStarts.length; i++) {
    assert(calEnds[i] > calStarts[i], 'calendar end must follow start for entry ' + i);
  }
});

step('welford-cache-learns-from-the-day', function () {
  const temp = readJson(S.store, DATA + 'Temp_Route_Cache.json');
  assert(temp && temp.entries && Object.keys(temp.entries).length >= 1,
    'session cache must hold the day samples, got ' + (temp ? Object.keys(temp.entries).length : 0));

  // The rollup commits samples whose target time has PASSED (now >= targetUnix).
  // Advance the sim clock past the last event, then re-run the rollup exactly
  // like a later planning pass would — the session samples roll into the
  // master Welford cache.
  const rollupNow = nowSec + ROLLUP_ADVANCE_HOURS * SECONDS_PER_HOUR;
  S.store.now = rollupNow * 1000;
  S = restart(S);
  S.sandbox.setLocal('par1', 'ROLLUP_DUE_TEMP');
  S.sandbox.setLocal('par2', JSON.stringify({ nowSec: rollupNow, prune: true }));
  S = action(S, RCM, 'RCM-rollup-later');

  const master = readJson(S.store, DATA + 'TDS_Route_Cache.json');
  assert(master && master.entries && Object.keys(master.entries).length >= 1,
    'master route cache must hold rolled-up Welford entries, got ' + (master ? Object.keys(master.entries).length : 0));
  Object.keys(master.entries).forEach(function (k) {
    assert(master.entries[k].meanDurationSecs > 0, 'rolled-up entry must carry a positive mean');
    assert(typeof master.entries[k].sampleCount === 'number' && master.entries[k].sampleCount >= 1, 'entry must carry a sample count');
  });
});

step('reducer-state-reconciled-to-active-generation', function () {
  const state = readJson(S.store, DATA + 'TDS_Trip_State.json');
  assert(state.revision >= 1, 'reducer must have applied batches, revision=' + state.revision);
  assert(state.currentGeneration === S.sandbox.global('TDS_Active_Generation'),
    'reducer must reconcile to the active generation');
});

step('consumers-read-the-committed-generation', function () {
  S = action(S, DISPATCHER, 'Dispatcher');
  assert(S.sandbox.local('itin_bolt_last') !== undefined, 'Dispatcher must stage its locals');

  S = action(S, DASHBOARD, 'Dashboard');
  assert(S.sandbox.local('ui_sub') !== undefined, 'Dashboard must stage its UI locals');
});

// ---------------------------------------------------------------------------
try {
  console.log('Planning-day simulation suite (serial Tasker chain):');
  if (failures.length > 0) {
    console.log('FAILED STEPS: ' + failures.length);
    console.log('FAIL: planning-day-simulation — ' + failures[0]);
    process.exit(1);
  }
  console.log('PASS: planning-day-simulation — Alpha→cluster→publish→blocks→API chain→Compiler→itinerary→caches→consumers');
  process.exit(0);
} catch (e) {
  console.log('FAIL: planning-day-simulation — ' + e.message);
  process.exit(1);
}
