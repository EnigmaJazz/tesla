// Phase 2 PR-A: Generation_Publisher contract and TDS_Helper resolver.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const MANIFEST = DATA + 'TDS_Run_Manifest.json';
const PUBLISHER = path.resolve(__dirname, '..', 'Generation_Publisher.js');
const HELPER = path.resolve(__dirname, '..', 'TDS_Helper.js');
const ID_RE = /^gen:\d{10}:[0-9a-f]{4}$/;

function seed(files) {
  const base = {};
  base[DATA + 'TDS_Master.json'] = '[]';
  base[DATA + 'Itin_Master.json'] = '[]';
  return Object.assign({}, base, files || {});
}
function make(files, failures, mathRandom) {
  const { sandbox, store } = createSandbox({ files: seed(files), nowMs: nowSec * 1000, failures: failures || {} });
  if (mathRandom) sandbox.Math.random = mathRandom;
  return { sandbox, store };
}
function runPub(files, candidate, failures, mathRandom) {
  const { sandbox, store } = make(files, failures, mathRandom);
  sandbox.setLocal('par1', candidate === undefined ? '' : (typeof candidate === 'string' ? candidate : JSON.stringify(candidate)));
  runScript(PUBLISHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  return { sandbox, store, result: sandbox.local('return_value') };
}
function manifest(store) {
  const raw = store.files[MANIFEST];
  return raw ? JSON.parse(raw) : null;
}
function prior() {
  const id = 'gen:1699999999:0001';
  const files = {};
  files[MANIFEST] = JSON.stringify({ schemaVersion: 1, generationId: id, activeGeneration: id, previousGeneration: null, publishedAt: nowSec - 1, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_1699999999_0001.json', masterPath: DATA + 'TDS_Master.gen_1699999999_0001.json', itineraryPath: DATA + 'Itin_Master.gen_1699999999_0001.json', eventCount: 1, legCount: 1, itineraryCount: 1, generationHistory: [id], state: 'committed' });
  files[DATA + 'TDS_Master.gen_1699999999_0001.json'] = JSON.stringify([{ id: 'p1' }]);
  files[DATA + 'Itin_Master.gen_1699999999_0001.json'] = JSON.stringify([{ tripId: 'pt1' }]);
  files[DATA + 'TDS_Events.gen_1699999999_0001.json'] = JSON.stringify([{ id: 'pe1' }]);
  return files;
}
function runHelper(files, par1) {
  const { sandbox, store } = make(files);
  sandbox.setLocal('par1', par1);
  sandbox.setLocal('par2', '');
  runScript(HELPER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  return sandbox.local('return_value');
}
function fail(msg) { console.log('FAIL: atomic-publication: ' + msg); process.exit(1); }

function testResolver() {
  const id = 'gen:1700000000:ab12';
  const files = {};
  files[MANIFEST] = JSON.stringify({ schemaVersion: 1, activeGeneration: id, previousGeneration: null, publishedAt: nowSec, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_1700000000_ab12.json', masterPath: DATA + 'TDS_Master.gen_1700000000_ab12.json', itineraryPath: DATA + 'Itin_Master.gen_1700000000_ab12.json', eventCount: 1, legCount: 1, itineraryCount: 1, generationHistory: [id], state: 'committed' });
  files[DATA + 'TDS_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'evt1' }]);
  files[DATA + 'Itin_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ tripId: 'leg1' }]);
  files[DATA + 'TDS_Events.gen_1700000000_ab12.json'] = JSON.stringify([{ eventId: 'evt1' }]);
  assert.deepEqual(JSON.parse(runHelper(files, 'master')), [{ id: 'evt1' }]);
  assert.deepEqual(JSON.parse(runHelper(files, 'itinerary')), [{ tripId: 'leg1' }]);
  assert.deepEqual(JSON.parse(runHelper(files, 'events')), [{ eventId: 'evt1' }]);

  const priorFiles = prior();
  priorFiles[MANIFEST] = JSON.stringify(Object.assign(JSON.parse(priorFiles[MANIFEST]), { state: 'failed' }));
  priorFiles[DATA + 'TDS_Master.gen_1700000000_ab12.json'] = 'CORRUPT';
  assert.deepEqual(JSON.parse(runHelper(priorFiles, 'master')), [{ id: 'p1' }]);

  assert.deepEqual(JSON.parse(runHelper({}, 'master')), []);

  const { sandbox, store } = make();
  sandbox.setLocal('par1', 'master:0:id');
  sandbox.setLocal('par2', 'newValue');
  runScript(HELPER, sandbox, store);
  const rv = sandbox.local('return_value');
  assert(rv.indexOf('ERROR:') === 0 && rv.indexOf('setter is removed') !== -1, 'setter should be rejected');
}

function testId() {
  const a = runPub({}, { events: [], master: [], itinerary: [] });
  assert.match(a.result, ID_RE);
  const b = runPub({}, { events: [], master: [], itinerary: [] });
  assert.match(b.result, ID_RE);
  assert.notStrictEqual(a.result, b.result);

  const existing = 'gen:' + nowSec + ':0000';
  const files = {};
  files[MANIFEST] = JSON.stringify({ schemaVersion: 1, generationId: existing, activeGeneration: existing, previousGeneration: null, publishedAt: nowSec, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_' + nowSec + '_0000.json', masterPath: DATA + 'TDS_Master.gen_' + nowSec + '_0000.json', itineraryPath: DATA + 'Itin_Master.gen_' + nowSec + '_0000.json', eventCount: 0, legCount: 0, itineraryCount: 0, generationHistory: [existing], state: 'committed' });
  let calls = 0;
  const r = runPub(files, { events: [], master: [], itinerary: [] }, {}, function () { calls++; return calls === 1 ? 0 : 1 / 0x10000; });
  assert.strictEqual(r.result, 'gen:' + nowSec + ':0001');
}

function testPublish() {
  const c = { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] };
  const r = runPub({}, c);
  const m = manifest(r.store);
  assert(m && m.state === 'committed' && m.activeGeneration === r.result && m.writer === 'Generation Publisher');
  assert.strictEqual(m.eventCount, 1); assert.strictEqual(m.legCount, 1); assert.strictEqual(m.itineraryCount, 1);
  assert.strictEqual(r.sandbox.global('TDS_Active_Generation'), r.result);

  const t = runPub({}, c, { tornWrites: ['TDS_Run_Manifest.json'] });
  assert(t.result.indexOf('ERROR:') === 0);
  assert.strictEqual(t.sandbox.global('TDS_Active_Generation'), '');
}

function testFailures() {
  const c = { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] };
  [
    { name: 'events', throws: ['TDS_Events'] },
    { name: 'master', throws: ['TDS_Master.gen_'] },
    { name: 'itinerary', throws: ['Itin_Master.gen_'] },
    { name: 'manifest', throws: ['TDS_Run_Manifest.json'] }
  ].forEach(function (b) {
    const r = runPub(prior(), c, { writeThrows: b.throws });
    assert(r.result.indexOf('ERROR:') === 0, b.name + ' should error');
    const m = manifest(r.store);
    assert(m && m.activeGeneration === 'gen:1699999999:0001', b.name + ' should preserve prior active');
    assert.strictEqual(r.sandbox.global('TDS_Active_Generation'), '');
  });
  const i = runPub({}, { events: null, master: [], itinerary: [] });
  assert(i.result.indexOf('ERROR:') === 0, 'invalid candidate should error');

  const t = runPub({}, { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [] }, { tornWrites: ['TDS_Events.gen_'] });
  assert(t.result.indexOf('ERROR:') === 0, 'torn events write should fail');
}

function testRetention() {
  const ids = [];
  let files = {};
  for (let i = 0; i < 6; i++) {
    const r = runPub(files, { events: [{ n: i }], master: [{ n: i }], itinerary: [{ n: i }] });
    ids.push(r.result);
    files = r.store.files;
  }
  const oldEnc = ids[0].replace(/:/g, '_');
  assert(!files[DATA + 'TDS_Events.' + oldEnc + '.json'], 'oldest events pruned');
  assert(!files[DATA + 'TDS_Master.' + oldEnc + '.json'], 'oldest master pruned');
  assert(!files[DATA + 'Itin_Master.' + oldEnc + '.json'], 'oldest itinerary pruned');
  const newEnc = ids[5].replace(/:/g, '_');
  assert(files[DATA + 'TDS_Events.' + newEnc + '.json'], 'newest events retained');
}

function testMigration() {
  const files = {};
  files[DATA + 'TDS_Master.json'] = JSON.stringify([{ id: 'legacy1' }]);
  files[DATA + 'Itin_Master.json'] = JSON.stringify([{ tripId: 'legacyItin1' }]);
  const r = runPub(files, 'MIGRATE');
  assert.match(r.result, ID_RE);
  assert(r.store.files[DATA + 'TDS_Master.legacy.json']);
  assert(r.store.files[DATA + 'Itin_Master.legacy.json']);
  const m = manifest(r.store);
  assert.strictEqual(m.eventCount, 0); assert.strictEqual(m.legCount, 1); assert.strictEqual(m.itineraryCount, 1);
}

function readViaResolver(store, kind) {
  return JSON.parse(runHelper(store.files, kind));
}

function testCompilerCutover() {
  const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');
  const futureEventStart = nowSec + 3600;
  const durationSecs = 1800;
  const masterJson = JSON.stringify([
    {
      id: 'abc123_kx8f00',
      start: futureEventStart,
      end: futureEventStart + 3600,
      duration: 3600,
      title: 'Future Event',
      desc: '',
      loc: 'Work',
      coords: '52.1,-2.2'
    }
  ]);
  const locals = {
    block_step1: 'EVENT',
    block_step2: 'Future Event',
    block_step3: '52.1,-2.2',
    block_step4: 'DRIVE',
    block_step5: String(futureEventStart),
    block_step7: 'false',
    block_step8: 'DEPART',
    block_step9: String(futureEventStart),
    block_step10: 'abc123_kx8f00',
    block_step14: '',
    block_step15: '',
    block_step16: '',
    block_step19: 'JIT',
    api_duration_secs: String(durationSecs),
    api_distance_miles: '15',
    api_transit_steps: '',
    virtual_time: String(nowSec - 60)
  };
  const globals = {
    User_At_Base: 'true',
    User_Loc: '51.9,-2.1',
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5'
  };
  const files = {
    [DATA + 'TDS_Master.json']: masterJson,
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}'
  };
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  runScript(COMPILER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  const m = manifest(store);
  assert(m && m.state === 'committed', 'Compiler should publish a committed generation');
  assert.strictEqual(m.eventCount, 1, 'Compiler published event count');
  assert.strictEqual(m.itineraryCount, 1, 'Compiler published itinerary count');
  const itin = JSON.parse(store.files[m.itineraryPath]);
  assert(itin.length === 1, 'Compiler published one leg');
  assert.strictEqual(itin[0].departurePolicy, 'JIT');
  assert.strictEqual(store.files[DATA + 'Itin_Master.json'], '[]', 'Compiler should not write live Itin_Master.json');
}

function testFinaliserCutover() {
  const FINALISER = path.resolve(__dirname, '..', 'Finaliser.js');
  const tempEvents = [
    {
      id: 'ev1_abc123',
      start: nowSec + 3600,
      end: nowSec + 7200,
      title: 'Work',
      loc: 'Work',
      coords: '52.1,-2.2'
    }
  ];
  const locals = {
    tds_temp_json: JSON.stringify(tempEvents)
  };
  const globals = {
    User_Loc: '51.9,-2.1',
    User_At_Base: 'true'
  };
  const files = {
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}'
  };
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  runScript(FINALISER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);

  const m = manifest(store);
  assert(m && m.state === 'committed', 'Finaliser should publish a committed generation');
  assert.strictEqual(m.eventCount, 1, 'Finaliser published event count');
  const events = JSON.parse(store.files[m.eventsPath]);
  assert.strictEqual(events[0].id, 'ev1_abc123');
  assert.strictEqual(store.files[DATA + 'TDS_Master.json'], undefined, 'Finaliser should not write live TDS_Master.json');
}

function testReaderFallback() {
  const id = 'gen:1700000000:cd34';
  const prevId = 'gen:1700000000:ab12';
  const files = {};
  files[MANIFEST] = JSON.stringify({
    schemaVersion: 1,
    activeGeneration: id,
    previousGeneration: prevId,
    publishedAt: nowSec,
    writer: 'Generation Publisher',
    eventsPath: DATA + 'TDS_Events.gen_1700000000_cd34.json',
    masterPath: DATA + 'TDS_Master.gen_1700000000_cd34.json',
    itineraryPath: DATA + 'Itin_Master.gen_1700000000_cd34.json',
    eventCount: 1,
    legCount: 1,
    itineraryCount: 1,
    generationHistory: [prevId, id],
    state: 'committed'
  });
  files[DATA + 'TDS_Events.gen_1700000000_cd34.json'] = 'CORRUPT';
  files[DATA + 'TDS_Master.gen_1700000000_cd34.json'] = 'CORRUPT';
  files[DATA + 'Itin_Master.gen_1700000000_cd34.json'] = 'CORRUPT';
  files[DATA + 'TDS_Events.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'prior' }]);
  files[DATA + 'TDS_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'prior' }]);
  files[DATA + 'Itin_Master.gen_1700000000_ab12.json'] = JSON.stringify([{
    tripId: 'prior_trip',
    mode: 'DRIVE',
    departUnix: nowSec + 3600,
    arriveUnix: nowSec + 5400,
    targetTitle: 'Work',
    targetCoords: '52.1,-2.2'
  }]);

  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: files, globals: { Current_Status: 'Idle' }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  assert.strictEqual(sandbox.local('itin_mode1'), 'DRIVE', 'Dispatcher should fall back to the prior generation when the active generation is unreadable');
  const idleFlash = store.flashLog.find(function (f) { return f.indexOf('IDLE_SYNC_ENGAGED') !== -1; });
  assert(!idleFlash, 'Dispatcher should not idle-sync when the prior generation has an actionable trip');
}

function testEmptyFallback() {
  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: {}, globals: { Current_Status: 'Idle' }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  assert.strictEqual(sandbox.local('itin_mode1'), 'NONE', 'Dispatcher should see NONE with no manifest');
  const flash = store.flashLog.find(function (f) { return f.indexOf('IDLE_SYNC_ENGAGED') !== -1; });
  assert(flash, 'Dispatcher should idle sync with no manifest');
}

function testCutoverProof() {
  const fs = require('node:fs');
  const compilerSource = fs.readFileSync(path.resolve(__dirname, '..', 'Compiler.js'), 'utf8');
  const finaliserSource = fs.readFileSync(path.resolve(__dirname, '..', 'Finaliser.js'), 'utf8');
  const directWriteRe = /writeFile\s*\(\s*["']Tasker\/Tesla\/Data\/(TDS_Master\.json|Itin_Master\.json)["']\s*,/;
  assert(!directWriteRe.test(compilerSource), 'Compiler.js must not contain direct writeFile to TDS_Master.json or Itin_Master.json');
  assert(!directWriteRe.test(finaliserSource), 'Finaliser.js must not contain direct writeFile to TDS_Master.json or Itin_Master.json');
}

function testReorderTiming() {
  const expectedGen = 'gen:' + nowSec + ':ab12';
  const files = prior();
  files[DATA + 'TDS_Reorder_Commands.json'] = JSON.stringify([{
    type: 'APPLY_CLUSTER_REORDER',
    generationId: expectedGen,
    clusterId: 'cluster-1',
    orderedEventIds: ['e3', 'e1', 'e2'],
    source: 'test',
    emittedAt: nowSec
  }]);
  const candidate = {
    events: [
      { id: 'e1', start: nowSec },
      { id: 'e2', start: nowSec },
      { id: 'e3', start: nowSec }
    ],
    master: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
    itinerary: []
  };
  const r = runPub(files, candidate, {}, function () { return 0xab12 / 0x10000; });
  assert.strictEqual(r.result, expectedGen, 'publisher should mint the expected generation');
  const m = manifest(r.store);
  const master = JSON.parse(r.store.files[m.masterPath]);
  assert.deepStrictEqual(master.map(function (x) { return x.id; }), ['e3', 'e1', 'e2'], 'reorder command must be applied before master write');
  const appliedLog = r.store.flashLog.find(function (f) { return f.indexOf('REORDER_COMMANDS_APPLIED') !== -1; });
  assert(appliedLog, 'publisher should log reorder command application');
}

function testStaleReorderRejection() {
  const expectedGen = 'gen:' + nowSec + ':ab12';
  const staleGen = 'gen:1699999999:0001';
  const files = prior();
  files[DATA + 'TDS_Reorder_Commands.json'] = JSON.stringify([{
    type: 'APPLY_CLUSTER_REORDER',
    generationId: staleGen,
    clusterId: 'cluster-1',
    orderedEventIds: ['e3', 'e1', 'e2'],
    source: 'test',
    emittedAt: nowSec
  }]);
  const candidate = {
    events: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
    master: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
    itinerary: []
  };
  const r = runPub(files, candidate, {}, function () { return 0xab12 / 0x10000; });
  const m = manifest(r.store);
  const master = JSON.parse(r.store.files[m.masterPath]);
  assert.deepStrictEqual(master.map(function (x) { return x.id; }), ['e1', 'e2', 'e3'], 'stale reorder command must be rejected');
  const log = r.store.flashLog.find(function (f) { return f.indexOf('REORDER_COMMAND_REJECTED') !== -1 || f.indexOf('STALE_REORDER_COMMAND_REJECTED') !== -1; });
  assert(log, 'stale reorder command should be logged as rejected');
}

try {
  testResolver();
  testId();
  testPublish();
  testFailures();
  testRetention();
  testMigration();
  testCompilerCutover();
  testFinaliserCutover();
  testReaderFallback();
  testEmptyFallback();
  testCutoverProof();
  testReorderTiming();
  testStaleReorderRejection();
  console.log('PASS: atomic-publication: publisher and resolver contract OK');
} catch (e) {
  fail(e.message);
}
