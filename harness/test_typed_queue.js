// Phase 5 Slice A — typed queue envelope contract (REQ-5QUEUE-1, REQ-5CUTOVER-1).
//
// Sandbox emits block_queue as {schemaVersion,rows,eof,skipIdxUntil,
// stepConflict,notifications} JSON; Compiler JSON.parses it once inside its
// JSlet — Tasker Variable Split never processes it. This harness covers:
//   SCN-5QUEUE-1     valid envelope: rows + EOF/skip/conflict/notification
//                    controls retain their values after one parse
//   SCN-5QUEUE-2     malformed JSON / unsupported schema / invalid row ->
//                    TYPED_QUEUE_REJECTED, nothing compiled (no partial rows)
//   SCN-5CUTOVER-2   cutover: legacy block_step17-21 retired; typed row authoritative
//                    head row during the shadow phase (equivalence check)
//   INV-0.7 tier 2   positive typed routeDurationSecs/routeDistanceMiles
//                    consumed before any local estimate (API -> SANDBOX)
//   SCN-5CUTOVER-3   typed + API metrics unavailable -> EVT-ZERO_DURATION_LEG_REJECTED
//   EOF              an empty-row envelope when idx exceeds the master length

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const homeCoords = '51.9,-2.1';
const eventCoords = '52.0,-2.0';
const futureEventStart = nowSec + 3600;
const DATA = 'Tasker/Tesla/Data/';
const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');

const SCH3_ORIGIN_SOURCES = [
  'ACTIVE_MANUAL_TRIP', 'ACTIVE_PLANNED_TRIP', 'LIVE_BASE', 'LIVE_LOCATION',
  'CONFIRMED_LAST_DESTINATION', 'OVERNIGHT_BASE_RESET', 'LEGACY_ITINERARY_FALLBACK'
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPED_FIELDS = [
  'rowType', 'title', 'coords', 'mode', 'displayTime', 'departTime',
  'pitstopState', 'apiTimeType', 'apiTimeUnix', 'evId', 'evLoc',
  'engineLateMins', 'currentLegStable', 'dropinStatusFlag', 'safeDesc',
  'adHoc', 'routeDurationSecs', 'routeDistanceMiles', 'departurePolicy',
  'planningDay', 'originSource'
];

const baseGeocodes = [nowSec, nowSec + 86400, homeCoords, '0', 'Home', '', 'home_base'].join('~');
const masterJson = JSON.stringify([{
  id: 'event_1_kx8f00',
  start: futureEventStart,
  end: futureEventStart + 3600,
  duration: 3600,
  title: 'Future Event',
  desc: '',
  loc: 'Work',
  coords: eventCoords
}]);

const sandboxGlobals = {
  User_At_Base: 'true',
  Base_Arrival_Unix: nowSec.toString(),
  User_Loc: homeCoords,
  Home_Coords: homeCoords,
  Current_Status: '',
  Arrival_Buffer_Mins: '5',
  Departure_Buffer_Mins: '5',
  Max_Walk_Meters: '8046',
  Daily_Walk_Meters: '0',
  Live_Traffic_Threshold: '7200',
  Car_Connected: 'false'
};

function runSandbox(extraFiles, extraLocals) {
  const files = Object.assign({
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Master.json']: masterJson,
    [DATA + 'TDS_Base_Geocodes.txt']: baseGeocodes,
    [DATA + 'TDS_Overrides.json']: '{}',
    [DATA + 'Temp_Route_Cache.txt']: '',
    [DATA + 'RouteCache.txt']: ''
  }, extraFiles || {});
  const locals = Object.assign({ idx: '1', vcar_loc: homeCoords, virtual_time: String(nowSec), virtual_loc: homeCoords }, extraLocals || {});
  const { sandbox, store } = createSandbox({ locals: locals, globals: sandboxGlobals, files: files, nowMs: nowSec * 1000 });
  runScript(SANDBOX, sandbox, store);
  return store;
}

function parseEnvelope(store) {
  const raw = store.locals['block_queue'];
  assert(raw && raw !== 'EOF', 'block_queue must be a JSON envelope, got ' + JSON.stringify(raw));
  return JSON.parse(raw);
}

// Compiler helpers (single-row envelope + API metric locals).
function runCompiler(row, opts) {
  opts = opts || {};
  const locals = Object.assign({
    block_queue: makeEnvelope([row], { eof: true, skipIdxUntil: 1 }),
    api_duration_secs: opts.apiDurationSecs !== undefined ? String(opts.apiDurationSecs) : '',
    api_distance_miles: opts.apiDistanceMiles !== undefined ? String(opts.apiDistanceMiles) : '',
    api_transit_steps: '',
    virtual_time: String(nowSec - 60)
  }, opts.extraLocals || {});
  const files = Object.assign({
    [DATA + 'TDS_Master.json']: masterJson,
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}'
  }, opts.files || {});
  const globals = Object.assign({
    User_At_Base: 'true',
    User_Loc: homeCoords,
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5'
  }, opts.globals || {});
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  runScript(COMPILER, sandbox, store);
  return store;
}

function readItinerary(store) {
  const manifestRaw = store.files[DATA + 'TDS_Run_Manifest.json'];
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw);
  return store.files[manifest.itineraryPath] ? JSON.parse(store.files[manifest.itineraryPath]) : null;
}

function findFlash(store, code) {
  return store.flashLog.find(function (m) { return m.indexOf(code) !== -1; });
}

function fail(msg) {
  console.log('FAIL: typed-queue — ' + msg);
  process.exit(1);
}

try {
  // ------------------------------------------------------------------
  // SCN-5QUEUE-1: valid envelope parses once; rows and tail controls
  // retain their values; every row is a complete TypedRow.
  // ------------------------------------------------------------------
  const store = runSandbox();
  if (store.runError) fail('Sandbox threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  const env = parseEnvelope(store);
  assert.strictEqual(env.schemaVersion, 1, 'envelope schemaVersion must be 1');
  assert.strictEqual(env.eof, false, 'a planned pass must not set eof');
  assert(Array.isArray(env.rows) && env.rows.length > 0, 'envelope must carry planned rows');
  assert(typeof env.skipIdxUntil === 'number' && env.skipIdxUntil >= 0, 'skipIdxUntil must be an integer');
  assert(env.stepConflict === null || typeof env.stepConflict === 'string', 'stepConflict must be null or string');
  assert(Array.isArray(env.notifications), 'notifications must be an array');

  const head = env.rows[0];
  TYPED_FIELDS.forEach(function (f) {
    assert(Object.prototype.hasOwnProperty.call(head, f), 'head row must carry typed field ' + f);
  });
  assert.strictEqual(head.rowType, 'EVENT', 'head row must be the EVENT leg');
  assert(typeof head.displayTime === 'number' && typeof head.departTime === 'number' && typeof head.apiTimeUnix === 'number', 'typed times must be numbers');
  assert(typeof head.currentLegStable === 'boolean', 'currentLegStable must be a boolean');
  assert(Array.isArray(head.adHoc), 'adHoc must be a number array');
  assert(head.routeDurationSecs === null || (head.routeDurationSecs > 0), 'routeDurationSecs must be positive or null');
  assert(head.routeDistanceMiles === null || (head.routeDistanceMiles > 0), 'routeDistanceMiles must be positive or null');
  assert(head.departurePolicy === 'ASAP' || head.departurePolicy === 'JIT', 'departurePolicy must be ASAP|JIT');
  assert(DAY_RE.test(head.planningDay || ''), 'planningDay must be YYYY-MM-DD, got ' + JSON.stringify(head.planningDay));
  assert(SCH3_ORIGIN_SOURCES.indexOf(head.originSource) !== -1, 'originSource must be in the SCH-3 enum');

  env.rows.forEach(function (row, i) {
    if (row.departurePolicy !== 'ASAP' && row.departurePolicy !== 'JIT') {
      fail('row ' + i + ' missing explicit departurePolicy (got ' + JSON.stringify(row.departurePolicy) + ')');
    }
  });

  // The head EVENT row must export positive Sandbox route metrics in the
  // typed fields (INV-0.7 tier 2) — the fixture drives an away event.
  assert(head.routeDurationSecs > 0, 'head typed routeDurationSecs must be positive for an away leg');
  assert(head.routeDistanceMiles > 0, 'head typed routeDistanceMiles must be positive for an away leg');

  // SCN-5CUTOVER-2 (cutover complete): the legacy block_step17-21 split
  // locals are RETIRED — they must NOT be produced by Sandbox or read by
  // Compiler. Typed row fields are authoritative.
  ['block_step17', 'block_step18', 'block_step19', 'block_step20', 'block_step21'].forEach(function (k) {
    if (store.locals[k] !== undefined && store.locals[k] !== '') {
      fail('cutover: Sandbox must not emit legacy ' + k + ' (got ' + JSON.stringify(store.locals[k]) + ')');
    }
  });

  // ------------------------------------------------------------------
  // EOF: an empty-row envelope (idx beyond the master length).
  // ------------------------------------------------------------------
  const eofStore = runSandbox({}, { idx: '99' });
  if (eofStore.runError) fail('EOF Sandbox threw: ' + eofStore.runError.message);
  const eofEnv = JSON.parse(eofStore.locals['block_queue']);
  assert.strictEqual(eofEnv.schemaVersion, 1, 'EOF envelope schemaVersion must be 1');
  assert.strictEqual(eofEnv.eof, true, 'EOF envelope must set eof:true');
  assert.deepStrictEqual(eofEnv.rows, [], 'EOF envelope must carry no rows');
  assert(typeof eofEnv.skipIdxUntil === 'number', 'EOF envelope must carry skipIdxUntil');
  assert.strictEqual(eofEnv.stepConflict, null, 'EOF envelope stepConflict must be null');
  assert.deepStrictEqual(eofEnv.notifications, [], 'EOF envelope notifications must be empty');

  // ------------------------------------------------------------------
  // SCN-5QUEUE-2: malformed input rejects the queue without compiling
  // partial rows (TYPED_QUEUE_REJECTED).
  // ------------------------------------------------------------------
  const baseRow = makeTypedRow({
    rowType: 'EVENT', title: 'Future Event', coords: eventCoords, mode: 'DRIVE',
    displayTime: futureEventStart, departTime: futureEventStart, pitstopState: 'false',
    apiTimeType: 'DEPART', apiTimeUnix: futureEventStart, evId: 'event_1_kx8f00',
    evLoc: 'Work', engineLateMins: 0, currentLegStable: false,
    dropinStatusFlag: 'none', safeDesc: '', adHoc: [],
    departurePolicy: 'JIT', planningDay: '2026-10-24', originSource: 'LIVE_BASE'
  });

  const malformed = runCompiler(baseRow, { extraLocals: { block_queue: '{not json' } });
  if (malformed.runError) fail('malformed envelope fixture threw: ' + malformed.runError.message);
  const malformedFlash = findFlash(malformed, 'TYPED_QUEUE_REJECTED');
  if (!malformedFlash) fail('malformed JSON must log TYPED_QUEUE_REJECTED');
  if (malformed.files[DATA + 'TDS_Run_Manifest.json']) fail('malformed JSON must not publish a generation');

  const badSchema = runCompiler(baseRow, { extraLocals: { block_queue: JSON.stringify({ schemaVersion: 99, rows: [baseRow], eof: true, skipIdxUntil: 0, stepConflict: null, notifications: [] }) } });
  if (!findFlash(badSchema, 'TYPED_QUEUE_REJECTED')) fail('unsupported schemaVersion must log TYPED_QUEUE_REJECTED');
  if (badSchema.files[DATA + 'TDS_Run_Manifest.json']) fail('unsupported schemaVersion must not publish a generation');

  // Two rows where the SECOND is invalid: the whole queue is rejected and
  // even the valid first row must not compile (no partial rows).
  const invalidRow = makeTypedRow(Object.assign({}, baseRow, { departurePolicy: 'SOON' }));
  const twoRows = runCompiler(baseRow, { extraLocals: { block_queue: makeEnvelope([baseRow, invalidRow]) } });
  const invalidFlash = findFlash(twoRows, 'TYPED_QUEUE_REJECTED');
  if (!invalidFlash) fail('an invalid row must reject the whole queue (TYPED_QUEUE_REJECTED)');
  const twoRowsItin = readItinerary(twoRows);
  if (twoRowsItin && twoRowsItin.length > 0) fail('no partial rows may compile when any row is invalid');

  // ------------------------------------------------------------------
  // INV-0.7 tier 2: positive typed Sandbox metrics are consumed before any
  // local estimate (validated API metrics absent -> API -> SANDBOX fallback).
  // ------------------------------------------------------------------
  const fallbackRow = makeTypedRow(Object.assign({}, baseRow, { routeDurationSecs: 2400, routeDistanceMiles: 12.5 }));
  const fbStore = runCompiler(fallbackRow);
  if (fbStore.runError) fail('typed-fallback fixture threw: ' + fbStore.runError.message);
  const fbItin = readItinerary(fbStore);
  if (!fbItin) fail('typed-fallback: published itinerary was not found');
  if (fbItin.length !== 1) fail('typed-fallback: expected 1 leg, got ' + fbItin.length);
  assert.strictEqual(fbItin[0].durationSecs, 2400, 'typed-fallback: durationSecs must come from routeDurationSecs');
  assert.strictEqual(fbItin[0].distanceMiles, 12.5, 'typed-fallback: distanceMiles must come from routeDistanceMiles');
  const fbFlash = findFlash(fbStore, 'DEPARTURE_POLICY_FALLBACK_USED');
  if (!fbFlash) fail('typed-fallback: expected DEPARTURE_POLICY_FALLBACK_USED');
  assert.strictEqual(JSON.parse(fbFlash).details.from, 'API', 'typed-fallback details.from must be API');
  assert.strictEqual(JSON.parse(fbFlash).details.to, 'SANDBOX', 'typed-fallback details.to must be SANDBOX');

  // ------------------------------------------------------------------
  // SCN-5CUTOVER-3: no API metrics and no typed metrics -> the leg is
  // rejected (EVT-ZERO_DURATION_LEG_REJECTED) and never publishes.
  // ------------------------------------------------------------------
  const zdStore = runCompiler(baseRow);
  if (zdStore.runError) fail('zero-duration fixture threw: ' + zdStore.runError.message);
  const zdFlash = findFlash(zdStore, 'ZERO_DURATION_LEG_REJECTED');
  if (!zdFlash) fail('zero-duration: expected EVT-ZERO_DURATION_LEG_REJECTED');
  assert.strictEqual(JSON.parse(zdFlash).tripId, 'event_1_kx8f00', 'zero-duration rejection must identify the trip');
  const zdItin = readItinerary(zdStore);
  if (zdItin && zdItin.length > 0) fail('zero-duration leg must not publish');

  console.log('PASS: typed queue envelope contract');
  console.log('  SCN-5QUEUE-1: envelope parsed once; rows + tail controls intact; typed head metrics positive');
  console.log('  SCN-5CUTOVER-2: legacy block_step17-21 retired; typed row authoritative');
  console.log('  SCN-5QUEUE-2: malformed/schema/invalid-row rejected with TYPED_QUEUE_REJECTED, nothing compiled');
  console.log('  INV-0.7 tier 2: typed routeDurationSecs/routeDistanceMiles consumed (API -> SANDBOX)');
  console.log('  SCN-5CUTOVER-3: zero-duration rejected; EOF envelope empty-row');
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
