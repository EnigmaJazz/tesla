// P1-2: an UNKNOWN generation read (a manifest that exists but yields no
// usable data) is never treated as a legitimately empty day. The Compiler and
// Finaliser must withhold their publish candidate and flash
// ITINERARY_READ_UNKNOWN, and the Sandbox must not present the unreadable
// master as an empty day. The true first-publish case (no manifest at all)
// must still publish — that is the control that keeps bootstrap working.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const MANIFEST = DATA + 'TDS_Run_Manifest.json';
const GEN = 'gen:1700000000:ab12';
const ENC = GEN.replace(/:/g, '_');
const ACTIVE_ITIN = DATA + 'Itin_Master.' + ENC + '.json';
const ACTIVE_MASTER = DATA + 'TDS_Master.' + ENC + '.json';
const CORRUPT_MANIFEST = '{oops';
const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');
const FINALISER = path.resolve(__dirname, '..', 'Finaliser.js');
const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function hasCode(store, code) {
  return logs(store).some(function (l) { return l.code === code; });
}
function hasUnknownSource(store, source) {
  return logs(store).some(function (l) {
    return l.code === 'ITINERARY_READ_UNKNOWN' && l.details && l.details.source === source;
  });
}

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: generation-read-unknown — ' + msg); }

const baseRow = makeTypedRow({
  rowType: 'EVENT', title: 'Future Event', coords: '52.1,-2.2', mode: 'DRIVE',
  displayTime: nowSec + 3600, departTime: nowSec + 3600, pitstopState: 'false',
  apiTimeType: 'DEPART', apiTimeUnix: nowSec + 3600, evId: 'abc123_kx8f00',
  evLoc: 'Work', engineLateMins: 0, currentLegStable: false,
  dropinStatusFlag: 'none', safeDesc: '', adHoc: [],
  departurePolicy: 'JIT', planningDay: '2023-11-14', originSource: 'LIVE_BASE'
});
const compilerLocals = {
  block_queue: makeEnvelope([baseRow], { eof: true, skipIdxUntil: 1 }),
  api_duration_secs: '1800',
  api_distance_miles: '15',
  api_transit_steps: '',
  virtual_time: String(nowSec - 60)
};
const compilerGlobals = {
  User_At_Base: 'true', User_Loc: '51.9,-2.1',
  Arrival_Buffer_Mins: '5', Departure_Buffer_Mins: '5'
};

// C1: corrupt manifest -> master read UNKNOWN -> no publish.
try {
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals,
    files: { [MANIFEST]: CORRUPT_MANIFEST }, nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (unknown master) threw: ' + store.runError.message);
  assert(hasUnknownSource(store, 'master'), 'Compiler must flash ITINERARY_READ_UNKNOWN{source:master}');
  assert.strictEqual(store.files[MANIFEST], CORRUPT_MANIFEST, 'Compiler must not publish when the generation read is UNKNOWN');
} catch (e) { fail('compiler-unknown-master: ' + e.message); }

// C2: committed manifest, readable master, missing itinerary -> no publish.
try {
  const manifest = {
    schemaVersion: 1, generationId: GEN, activeGeneration: GEN, previousGeneration: null,
    publishedAt: nowSec, writer: 'Generation Publisher',
    eventsPath: DATA + 'TDS_Events.' + ENC + '.json',
    masterPath: ACTIVE_MASTER,
    itineraryPath: ACTIVE_ITIN,
    eventCount: 1, legCount: 1, itineraryCount: 0, generationHistory: [GEN], state: 'committed'
  };
  const master = [{ id: 'abc123_kx8f00', start: nowSec + 3600, end: nowSec + 7200, duration: 3600, title: 'Future Event', loc: 'Work', coords: '52.1,-2.2' }];
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals,
    files: { [MANIFEST]: JSON.stringify(manifest), [ACTIVE_MASTER]: JSON.stringify(master) },
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (unknown itinerary) threw: ' + store.runError.message);
  assert(hasUnknownSource(store, 'itinerary'), 'Compiler must flash ITINERARY_READ_UNKNOWN{source:itinerary}');
  assert.strictEqual(store.files[ACTIVE_ITIN], undefined, 'Compiler must not publish when the itinerary read is UNKNOWN');
} catch (e) { fail('compiler-unknown-itinerary: ' + e.message); }

// C3 (control): no generation at all is the first-publish case and must still
// publish (a genuinely empty carried itinerary is legitimate).
try {
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals, files: {}, nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (first publish) threw: ' + store.runError.message);
  assert(!hasCode(store, 'ITINERARY_READ_UNKNOWN'), 'first publish must not flash ITINERARY_READ_UNKNOWN');
  assert(store.files[MANIFEST] !== undefined, 'first publish must still publish a generation');
} catch (e) { fail('compiler-first-publish: ' + e.message); }

// C4 (R1/R2): manifest present but the read THROWS -> UNKNOWN -> no publish,
// and the bare-readFile hazard is logged (FILE_READ_FAILED).
try {
  const validManifest = JSON.stringify({ schemaVersion: 1, state: 'committed', activeGeneration: GEN, previousGeneration: null, masterPath: ACTIVE_MASTER, itineraryPath: ACTIVE_ITIN, eventsPath: DATA + 'TDS_Events.' + ENC + '.json' });
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals,
    files: { [MANIFEST]: validManifest, [ACTIVE_MASTER]: JSON.stringify([{ id: 'abc123_kx8f00', start: nowSec + 3600, duration: 3600, title: 'Future Event', loc: 'Work', coords: '52.1,-2.2' }]) },
    failures: { readThrows: ['TDS_Run_Manifest.json'] },
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (throwing manifest read) threw: ' + store.runError.message);
  assert(hasCode(store, 'FILE_READ_FAILED'), 'a throwing read must log FILE_READ_FAILED');
  assert(hasUnknownSource(store, 'master'), 'Compiler must flash ITINERARY_READ_UNKNOWN{source:master}');
  assert.strictEqual(store.files[MANIFEST], validManifest, 'Compiler must not publish when the manifest read throws');
} catch (e) { fail('compiler-throwing-manifest-read: ' + e.message); }

// C5 (R1/R2): manifest present but %-unexpanded -> UNKNOWN -> no publish.
try {
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals,
    files: { [MANIFEST]: '%TDS_Run_Manifest' },
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (unexpanded manifest) threw: ' + store.runError.message);
  assert(hasUnknownSource(store, 'master'), 'Compiler must flash ITINERARY_READ_UNKNOWN{source:master}');
  assert.strictEqual(store.files[MANIFEST], '%TDS_Run_Manifest', 'Compiler must not publish when the manifest is unexpanded');
} catch (e) { fail('compiler-unexpanded-manifest: ' + e.message); }

// C6 (control, R2): manifest missing AND legacy missing -> [] -> first publish.
try {
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals, files: {}, nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (first publish control) threw: ' + store.runError.message);
  assert(!hasCode(store, 'ITINERARY_READ_UNKNOWN'), 'first publish must not flash ITINERARY_READ_UNKNOWN');
  assert(store.files[MANIFEST] !== undefined, 'first publish must still publish a generation');
} catch (e) { fail('compiler-first-publish-control: ' + e.message); }

// C7 (R1/R2): manifest missing but the legacy master is present-and-corrupt ->
// UNKNOWN -> no publish (a corrupt legacy is a failure, not an absence).
try {
  const { sandbox, store } = createSandbox({
    locals: compilerLocals, globals: compilerGlobals,
    files: { [DATA + 'TDS_Master.json']: '{oops' },
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, store);
  if (store.runError) fail('Compiler (corrupt legacy master) threw: ' + store.runError.message);
  assert(hasCode(store, 'FILE_PARSE_FAILED'), 'a corrupt legacy master must log FILE_PARSE_FAILED');
  assert(hasUnknownSource(store, 'master'), 'Compiler must flash ITINERARY_READ_UNKNOWN{source:master}');
  assert.strictEqual(store.files[MANIFEST], undefined, 'Compiler must not publish when the legacy master is corrupt');
} catch (e) { fail('compiler-corrupt-legacy-master: ' + e.message); }

// C8 (R2 caller audit): a caller receiving null must not throw and must not
// publish — Finaliser with a manifest read that throws.
try {
  const locals = {
    tds_temp_json: JSON.stringify([{ id: 'ev1_abc123', start: nowSec + 3600, end: nowSec + 7200, title: 'Work', loc: 'Work', coords: '52.1,-2.2' }])
  };
  const validManifest = JSON.stringify({ schemaVersion: 1, state: 'committed', activeGeneration: GEN, previousGeneration: null, itineraryPath: ACTIVE_ITIN });
  const { sandbox, store } = createSandbox({
    locals: locals,
    globals: { User_Loc: '51.9,-2.1', User_At_Base: 'true' },
    files: { [MANIFEST]: validManifest },
    failures: { readThrows: ['TDS_Run_Manifest.json'] },
    nowMs: nowSec * 1000
  });
  runScript(FINALISER, sandbox, store);
  if (store.runError) fail('Finaliser (null caller) threw: ' + store.runError.message);
  assert(hasCode(store, 'ITINERARY_READ_UNKNOWN'), 'Finaliser must flash ITINERARY_READ_UNKNOWN on a null itinerary read');
  assert.strictEqual(store.files[MANIFEST], validManifest, 'Finaliser must not publish when the itinerary read is UNKNOWN');
} catch (e) { fail('finaliser-null-caller: ' + e.message); }

// F1: unreadable itinerary -> Finaliser publishes nothing but still flashes.
try {
  const locals = {
    tds_temp_json: JSON.stringify([{ id: 'ev1_abc123', start: nowSec + 3600, end: nowSec + 7200, title: 'Work', loc: 'Work', coords: '52.1,-2.2' }])
  };
  const { sandbox, store } = createSandbox({
    locals: locals,
    globals: { User_Loc: '51.9,-2.1', User_At_Base: 'true' },
    files: { [MANIFEST]: CORRUPT_MANIFEST },
    nowMs: nowSec * 1000
  });
  runScript(FINALISER, sandbox, store);
  if (store.runError) fail('Finaliser (unknown itinerary) threw: ' + store.runError.message);
  assert(hasCode(store, 'ITINERARY_READ_UNKNOWN'), 'Finaliser must flash ITINERARY_READ_UNKNOWN');
  assert.strictEqual(store.files[MANIFEST], CORRUPT_MANIFEST, 'Finaliser must not publish an empty itinerary');
} catch (e) { fail('finaliser-unknown-itinerary: ' + e.message); }

// S1: unreadable master -> rows withheld, degradation flagged, schema unchanged.
try {
  const globals = {
    User_At_Base: 'true', User_Loc: '51.9,-2.1', Home_Coords: '51.9,-2.1', Current_Status: 'Idle',
    Arrival_Buffer_Mins: '5', Departure_Buffer_Mins: '5', Max_Walk_Meters: '8046',
    Daily_Walk_Meters: '0', Live_Traffic_Threshold: '7200', Car_Connected: 'false'
  };
  const { sandbox, store } = createSandbox({
    locals: { idx: '1', vcar_loc: '51.9,-2.1', virtual_time: String(nowSec), virtual_loc: '51.9,-2.1' },
    globals: globals,
    files: { [MANIFEST]: CORRUPT_MANIFEST },
    nowMs: nowSec * 1000
  });
  runScript(SANDBOX, sandbox, store);
  if (store.runError) fail('Sandbox (unknown master) threw: ' + store.runError.message);
  assert(hasCode(store, 'ITINERARY_READ_UNKNOWN'), 'Sandbox must flash ITINERARY_READ_UNKNOWN');
  const env = JSON.parse(store.locals['block_queue']);
  assert.strictEqual(env.schemaVersion, 1, 'envelope schema must be unchanged');
  assert.deepStrictEqual(env.rows, [], 'unreadable master must withhold rows');
  assert.strictEqual(env.stepConflict, 'ITINERARY_READ_UNKNOWN', 'degradation must be flagged via stepConflict');
  assert(Array.isArray(env.notifications), 'notifications must stay an array');
} catch (e) { fail('sandbox-unknown-master: ' + e.message); }

if (failures > 0) { console.log('FAIL: generation-read-unknown — ' + failures + ' scenario(s) failed'); process.exit(1); }
console.log('PASS: generation-read-unknown — Compiler/Finaliser withhold publish on UNKNOWN; first publish survives; Sandbox flags the degraded envelope');
process.exit(0);
