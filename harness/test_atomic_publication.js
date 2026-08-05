// Phase 2 PR-A: Generation_Publisher contract and TDS_Helper resolver.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
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
  // Identify the Generation Publisher so its reorder-queue drain/clear passes
  // the mock ownership guard (State Command enqueues; Publisher drains/clears).
  sandbox.__currentScriptPath = PUBLISHER;
  runScript(PUBLISHER, sandbox, store);
  sandbox.__currentScriptPath = '';
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
  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:master')), [{ id: 'evt1' }]);
  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:itinerary')), [{ tripId: 'leg1' }]);
  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:events')), [{ eventId: 'evt1' }]);

  const priorFiles = prior();
  priorFiles[MANIFEST] = JSON.stringify(Object.assign(JSON.parse(priorFiles[MANIFEST]), { state: 'failed' }));
  priorFiles[DATA + 'TDS_Master.gen_1699999999_0001.json'] = 'CORRUPT';
  assert.deepEqual(JSON.parse(runHelper(priorFiles, 'readActiveGeneration:master')), [], 'TDS_Helper must refuse a failed manifest active generation');

  assert.deepEqual(JSON.parse(runHelper({}, 'readActiveGeneration:master')), []);

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
  const enc = r.result.replace(/:/g, '_');
  assert(m && m.state === 'committed' && m.activeGeneration === r.result && m.writer === 'Generation Publisher');
  assert.strictEqual(m.schemaVersion, 1, 'manifest schemaVersion must be 1');
  assert.strictEqual(m.previousGeneration, null, 'first publication previousGeneration must be null');
  assert.strictEqual(m.publishedAt, nowSec, 'manifest publishedAt must match current time');
  assert.strictEqual(m.eventsPath, DATA + 'TDS_Events.' + enc + '.json', 'manifest eventsPath must be encoded');
  assert.strictEqual(m.masterPath, DATA + 'TDS_Master.' + enc + '.json', 'manifest masterPath must be encoded');
  assert.strictEqual(m.itineraryPath, DATA + 'Itin_Master.' + enc + '.json', 'manifest itineraryPath must be encoded');
  assert.strictEqual(m.eventCount, 1); assert.strictEqual(m.legCount, 1); assert.strictEqual(m.itineraryCount, 1);
  assert.deepStrictEqual(m.generationHistory, [r.result], 'first publication history must contain the active generation');
  assert.strictEqual(r.sandbox.global('TDS_Active_Generation'), r.result);

  const t = runPub({}, c, { tornWrites: ['TDS_Run_Manifest.json'] });
  assert(t.result.indexOf('ERROR:') === 0);
  assert.strictEqual(t.sandbox.global('TDS_Active_Generation'), '');
}

function testGenIdParsing() {
  const parts = 'gen:1784369000:ab12'.split(':');
  assert.strictEqual(parts[1], '1784369000');
  assert.strictEqual(parts[2], 'ab12');
  assert.match('gen:1784369000:ab12', ID_RE);
}

function testSupersedingPublication() {
  const a = runPub({}, { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] });
  assert.match(a.result, ID_RE);
  const b = runPub(a.store.files, { events: [{ id: 'e2' }], master: [{ id: 'l2' }], itinerary: [{ tripId: 't2' }] });
  assert.match(b.result, ID_RE);
  assert.notStrictEqual(a.result, b.result);
  const m = manifest(b.store);
  assert(m && m.state === 'committed' && m.activeGeneration === b.result && m.previousGeneration === a.result, 'superseding publication must link previous generation');
  assert(m.generationHistory.indexOf(a.result) !== -1 && m.generationHistory.indexOf(b.result) !== -1 && m.generationHistory[0] === b.result, 'superseding publication history must include both generations with newest first');
  assert.strictEqual(m.eventCount, 1);
  assert.strictEqual(m.legCount, 1);
  assert.strictEqual(m.itineraryCount, 1);
}

function testFirstCommitNoPrune() {
  const r = runPub({}, { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] });
  const enc = r.result.replace(/:/g, '_');
  const deleted = r.store.deleteOrder.some(function (p) {
    return p === DATA + 'TDS_Events.' + enc + '.json' || p === DATA + 'TDS_Master.' + enc + '.json' || p === DATA + 'Itin_Master.' + enc + '.json';
  });
  assert(!deleted, 'first commit must not prune the generation it just published');
}

function testRestartClearsGeneration() {
  const { sandbox } = make();
  assert.strictEqual(sandbox.global('TDS_Active_Generation'), '', 'TDS_Active_Generation must be empty after application restart');
}

function testFailures() {
  const c = { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] };
  const priorGen = 'gen:1699999999:0001';
  const priorEnc = priorGen.replace(/:/g, '_');
  [
    { name: 'events', throws: ['TDS_Events'] },
    { name: 'master', throws: ['TDS_Master.gen_'] },
    { name: 'itinerary', throws: ['Itin_Master.gen_'] },
    { name: 'manifest', throws: ['TDS_Run_Manifest.json'] }
  ].forEach(function (b) {
    const r = runPub(prior(), c, { writeThrows: b.throws });
    assert(r.result.indexOf('ERROR:') === 0, b.name + ' should error');
    const m = manifest(r.store);
    assert(m && m.activeGeneration === priorGen, b.name + ' should preserve prior active');
    assert.strictEqual(r.sandbox.global('TDS_Active_Generation'), '');
    if (b.name !== 'manifest') {
      assert.strictEqual(m.state, 'failed', b.name + ' failure must leave the candidate in failed state');
      assert.match(m.generationId, ID_RE, b.name + ' failed manifest must preserve the candidate generationId');
      assert.notStrictEqual(m.generationId, priorGen, b.name + ' failed candidate must have a distinct generationId');
      const candidateEnc = m.generationId.replace(/:/g, '_');
      const candidatePaths = [
        DATA + 'TDS_Events.' + candidateEnc + '.json',
        DATA + 'TDS_Master.' + candidateEnc + '.json',
        DATA + 'Itin_Master.' + candidateEnc + '.json'
      ];
      if (b.name === 'events') {
        assert(!candidatePaths.slice(1).some(function (p) { return r.store.writeOrder.indexOf(p) !== -1; }), 'events failure must stop later resource writes');
      } else if (b.name === 'master') {
        assert.strictEqual(r.store.writeOrder.indexOf(candidatePaths[2]), -1, 'master failure must stop itinerary write');
      } else if (b.name === 'itinerary') {
        assert(!r.store.writeOrder.some(function (p) { return p === MANIFEST && p !== r.store.writeOrder[r.store.writeOrder.length - 1]; }), 'itinerary failure must not write a committed manifest');
      }
    } else {
      assert.strictEqual(m.state, 'committed', 'manifest write failure must not overwrite the prior committed manifest');
    }
  });
  const i = runPub({}, { events: null, master: [], itinerary: [] });
  assert(i.result.indexOf('ERROR:') === 0, 'invalid candidate should error');
  const emptyManifest = manifest(i.store);
  assert(emptyManifest === null || emptyManifest.state === 'failed', 'invalid candidate must not produce a committed manifest');

  const t = runPub({}, { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [] }, { tornWrites: ['TDS_Events.gen_'] });
  assert(t.result.indexOf('ERROR:') === 0, 'torn events write should fail');
  assert.strictEqual(t.sandbox.global('TDS_Active_Generation'), '', 'torn events write must clear active generation');
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
  const master = [{ id: 'legacy1' }];
  const itin = [{ tripId: 'legacyItin1' }];
  const files = {};
  files[DATA + 'TDS_Master.json'] = JSON.stringify(master);
  files[DATA + 'Itin_Master.json'] = JSON.stringify(itin);
  const r = runPub(files, 'MIGRATE');
  assert.match(r.result, ID_RE);
  assert(r.store.files[DATA + 'TDS_Master.legacy.json']);
  assert(r.store.files[DATA + 'Itin_Master.legacy.json']);
  assert.deepStrictEqual(JSON.parse(r.store.files[DATA + 'TDS_Master.legacy.json']), master, 'legacy master backup must contain the original data');
  assert.deepStrictEqual(JSON.parse(r.store.files[DATA + 'Itin_Master.legacy.json']), itin, 'legacy itinerary backup must contain the original data');
  const m = manifest(r.store);
  assert.strictEqual(m.eventCount, 0); assert.strictEqual(m.legCount, 1); assert.strictEqual(m.itineraryCount, 1);
}

function testRollbackRestoresLegacy() {
  const master = [{ id: 'legacy1' }];
  const itin = [{ tripId: 'legacyItin1' }];
  const files = {};
  files[DATA + 'TDS_Master.json'] = JSON.stringify(master);
  files[DATA + 'Itin_Master.json'] = JSON.stringify(itin);
  const r = runPub(files, 'MIGRATE');
  assert.match(r.result, ID_RE);
  assert.deepStrictEqual(JSON.parse(r.store.files[DATA + 'TDS_Master.legacy.json']), master, 'rollback must restore legacy master from backup');
  assert.deepStrictEqual(JSON.parse(r.store.files[DATA + 'Itin_Master.legacy.json']), itin, 'rollback must restore legacy itinerary from backup');
  assert(r.store.files[DATA + 'TDS_Master.json'] !== undefined, 'legacy TDS_Master.json must remain readable for rollback');
  assert(r.store.files[DATA + 'Itin_Master.json'] !== undefined, 'legacy Itin_Master.json must remain readable for rollback');
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
    block_queue: makeEnvelope([makeTypedRow({
      rowType: 'EVENT',
      title: 'Future Event',
      coords: '52.1,-2.2',
      mode: 'DRIVE',
      displayTime: futureEventStart,
      departTime: futureEventStart,
      pitstopState: 'false',
      apiTimeType: 'DEPART',
      apiTimeUnix: futureEventStart,
      evId: 'abc123_kx8f00',
      evLoc: 'Work',
      engineLateMins: 0,
      currentLegStable: false,
      dropinStatusFlag: 'none',
      safeDesc: '',
      adHoc: [],
      departurePolicy: 'JIT',
      planningDay: '2023-11-14',
      originSource: 'LIVE_BASE'
    })]),
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

  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:master')), [{ id: 'prior' }], 'TDS_Helper should fall back to prior generation when active is corrupt');

  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: files, globals: { Current_Status: 'Idle' }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  assert.strictEqual(sandbox.local('itin_mode1'), 'DRIVE', 'Dispatcher should fall back to the prior generation when the active generation is unreadable');
  const idleFlash = store.flashLog.find(function (f) { return f.indexOf('IDLE_SYNC_ENGAGED') !== -1; });
  assert(!idleFlash, 'Dispatcher should not idle-sync when the prior generation has an actionable trip');
}

function testReadersRequireCommittedState() {
  const id = 'gen:1700000000:cd34';
  const files = {};
  files[MANIFEST] = JSON.stringify({
    schemaVersion: 1,
    generationId: id,
    activeGeneration: id,
    previousGeneration: null,
    publishedAt: nowSec,
    writer: 'Generation Publisher',
    eventsPath: DATA + 'TDS_Events.gen_1700000000_cd34.json',
    masterPath: DATA + 'TDS_Master.gen_1700000000_cd34.json',
    itineraryPath: DATA + 'Itin_Master.gen_1700000000_cd34.json',
    eventCount: 1,
    legCount: 1,
    itineraryCount: 1,
    generationHistory: [id],
    state: 'building'
  });
  files[DATA + 'TDS_Events.gen_1700000000_cd34.json'] = JSON.stringify([{ id: 'evt1' }]);
  files[DATA + 'TDS_Master.gen_1700000000_cd34.json'] = JSON.stringify([{ id: 'evt1' }]);
  files[DATA + 'Itin_Master.gen_1700000000_cd34.json'] = JSON.stringify([{ tripId: 'leg1', mode: 'DRIVE', departUnix: nowSec + 3600, arriveUnix: nowSec + 5400, targetTitle: 'Work' }]);

  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:master')), [], 'TDS_Helper must refuse a building manifest');
  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:itinerary')), [], 'TDS_Helper itinerary must refuse a building manifest');

  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: files, globals: { Current_Status: 'Idle' }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  assert.strictEqual(sandbox.local('itin_mode1'), 'NONE', 'Dispatcher must treat building manifest as empty');
  assert(store.flashLog.some(function (f) { return f.indexOf('IDLE_SYNC_ENGAGED') !== -1; }), 'Dispatcher should idle-sync with building manifest');

  const committedManifest = JSON.parse(files[MANIFEST]);
  committedManifest.state = 'committed';
  files[MANIFEST] = JSON.stringify(committedManifest);
  assert.deepEqual(JSON.parse(runHelper(files, 'readActiveGeneration:master')), [{ id: 'evt1' }], 'TDS_Helper must serve committed manifest');
  const itin = JSON.parse(runHelper(files, 'readActiveGeneration:itinerary'));
  assert.strictEqual(itin[0].tripId, 'leg1', 'TDS_Helper itinerary must serve committed manifest');
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
  // Commands emitted before generation minting carry a null generationId;
  // the Publisher applies them to the generation being published. Phase 4
  // (REQ-4REORDER-2): legacy-null is permitted only from a trusted producer.
  files[DATA + 'TDS_Reorder_Commands.json'] = JSON.stringify([{
    type: 'APPLY_CLUSTER_REORDER',
    generationId: null,
    clusterId: 'cluster-1',
    orderedEventIds: ['e3', 'e1', 'e2'],
    source: 'Gatekeeper',
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
  // Phase 4 (REQ-4REORDER-2): admission matches the pre-build committed
  // generation ('gen:1699999999:0001' from prior()) — never the minted id.
  // A command stamped with any OTHER generation is stale and must be rejected.
  const staleGen = 'gen:1800000000:ffff';
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
  assert.strictEqual(r.store.files[DATA + 'TDS_Reorder_Commands.json'], '[]', 'rejected command must be drained and cleared');
}

function testGatekeeperEmitsCommand() {
  const GATEKEEPER = path.resolve(__dirname, '..', 'Gatekeeper.js');
  const activeGen = 'gen:1700000000:ab12';
  const files = {};
  files[DATA + 'TDS_Reorder_Commands.json'] = '[]';
  const cluster = { waypoints: [{ id: 'wp1', dropinOrder: 2 }, { id: 'wp2', dropinOrder: 1 }], destination: { id: 'dest1', coords: '52.0,-2.0' } };
  const { sandbox, store } = createSandbox({
    locals: { par1: JSON.stringify(cluster), par11: '', par12: '', par13: '', par14: '' },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: activeGen },
    files: files,
    nowMs: nowSec * 1000
  });
  runScript(GATEKEEPER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  // Phase 4 (REQ-4REORDER-1): the producer stages ENQUEUE_REORDER; the State
  // Command owns the queue append.
  assert.strictEqual(sandbox.local('par1'), 'ENQUEUE_REORDER', 'Gatekeeper should stage ENQUEUE_REORDER');
  const staged = JSON.parse(sandbox.local('par2'));
  assert.deepStrictEqual(staged.orderedEventIds, ['wp2', 'wp1']);
  assert.strictEqual(staged.generationId, activeGen);
  assert(!store.writeLog.some(function (w) { return w.path === DATA + 'TDS_Reorder_Commands.json'; }), 'Gatekeeper must not write the queue directly');
  const result = sandbox.stateCommand('ENQUEUE_REORDER', staged);
  assert(result.indexOf('OK') === 0, 'router should accept the staged reorder command');
  const queue = JSON.parse(store.files[DATA + 'TDS_Reorder_Commands.json'] || '[]');
  assert.strictEqual(queue.length, 1, 'router should enqueue one reorder command');
  assert.strictEqual(queue[0].type, 'APPLY_CLUSTER_REORDER');
  assert.deepStrictEqual(queue[0].orderedEventIds, ['wp2', 'wp1']);
  const directMasterWrite = store.writeLog.some(function (w) { return w.path === DATA + 'TDS_Master.json'; });
  assert(!directMasterWrite, 'Gatekeeper must not write TDS_Master.json');
}

function testApiParserEmitsCommand() {
  const API_PARSER = path.resolve(__dirname, '..', 'API_Parser.js');
  const activeGen = 'gen:1700000000:ab12';
  const cluster = { waypoints: [{ id: 'wp1' }, { id: 'wp2' }], destination: { id: 'dest1' } };
  const payload = { routes: [{ optimizedIntermediateWaypointIndex: [1, 0] }] };
  const files = {};
  files[DATA + 'TDS_Reorder_Commands.json'] = '[]';
  files[DATA + 'temp_payload.json'] = JSON.stringify(payload);
  const { sandbox, store } = createSandbox({
    locals: { api_route_mode: 'CLUSTER', par1: JSON.stringify(cluster), par11: '', par12: '', par13: '', par14: '' },
    globals: { User_Loc: '51.9,-2.1', TDS_Active_Generation: activeGen },
    files: files,
    nowMs: nowSec * 1000
  });
  // Slice C correlation: register the request, then stage {correlation, response}.
  const corr = { generationId: activeGen, clusterId: '51.9,-2.1|dest1|wp1,wp2', requestId: 'req_cluster', emittedAt: nowSec };
  const reg = sandbox.cacheManager('REQUEST_STATE_REGISTER', corr);
  assert(reg.indexOf('OK') === 0, 'REQUEST_STATE_REGISTER must succeed: ' + reg);
  sandbox.setLocal('par1', JSON.stringify(cluster));
  sandbox.writeFile(DATA + 'temp_payload.json', JSON.stringify({ correlation: { generationId: activeGen, clusterId: '51.9,-2.1|dest1|wp1,wp2', requestId: 'req_cluster' }, response: payload }));
  runScript(API_PARSER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  // Phase 5 (REQ-5CACHE-1): API_Parser stages ORDER_CACHE_UPSERT; the Route
  // Cache Manager owns the order cache and re-stages ENQUEUE_REORDER for the
  // State Command (which owns the queue append).
  assert.strictEqual(sandbox.local('par1'), 'ORDER_CACHE_UPSERT', 'API_Parser should stage ORDER_CACHE_UPSERT');
  const staged = JSON.parse(sandbox.local('par2'));
  assert.deepStrictEqual(staged.orderedEventIds, ['wp2', 'wp1']);
  assert.strictEqual(staged.generationId, activeGen);
  assert(!store.writeLog.some(function (w) { return w.path === DATA + 'TDS_Reorder_Commands.json'; }), 'API_Parser must not write the queue directly');
  assert(!store.writeLog.some(function (w) { return w.path === DATA + 'TDS_Order_Cache.txt' || w.path === DATA + 'TDS_Order_Cache.json'; }), 'API_Parser must not write the order cache directly');
  const cacheResult = sandbox.cacheManager('ORDER_CACHE_UPSERT', staged);
  assert(cacheResult.indexOf('OK') === 0, 'manager should accept the staged order upsert');
  assert.strictEqual(sandbox.local('par1'), 'ENQUEUE_REORDER', 'manager should re-stage ENQUEUE_REORDER');
  const result = sandbox.stateCommand('ENQUEUE_REORDER', JSON.parse(sandbox.local('par2')));
  assert(result.indexOf('OK') === 0, 'router should accept the staged reorder command');
  const queue = JSON.parse(store.files[DATA + 'TDS_Reorder_Commands.json'] || '[]');
  assert.strictEqual(queue.length, 1, 'router should enqueue one reorder command');
  assert.strictEqual(queue[0].type, 'APPLY_CLUSTER_REORDER');
  assert.deepStrictEqual(queue[0].orderedEventIds, ['wp2', 'wp1']);
  const directMasterWrite = store.writeLog.some(function (w) { return w.path === DATA + 'TDS_Master.json'; });
  assert(!directMasterWrite, 'API_Parser must not write TDS_Master.json');
}

function testRule8aOwnership() {
  const fs = require('node:fs');
  const directWriteRe = /writeFile\s*\(\s*["']Tasker\/Tesla\/Data\/(TDS_Master\.json|Itin_Master\.json)["']\s*,/;
  const alphaClearRe = /writeFile\s*\(\s*["']Tasker\/Tesla\/Data\/TDS_Master\.json["']\s*,\s*"\[\]"/;
  const alphaItinClearRe = /writeFile\s*\(\s*["']Tasker\/Tesla\/Data\/Itin_Master\.json["']\s*,\s*"\[\]"/;
  const gatekeeperSource = fs.readFileSync(path.resolve(__dirname, '..', 'Gatekeeper.js'), 'utf8');
  const apiParserSource = fs.readFileSync(path.resolve(__dirname, '..', 'API_Parser.js'), 'utf8');
  const alphaSource = fs.readFileSync(path.resolve(__dirname, '..', 'Alpha.js'), 'utf8');
  assert(!directWriteRe.test(gatekeeperSource), 'Gatekeeper.js must not write TDS_Master.json or Itin_Master.json');
  assert(!directWriteRe.test(apiParserSource), 'API_Parser.js must not write TDS_Master.json or Itin_Master.json');
  assert(!alphaClearRe.test(alphaSource), 'Alpha.js must not clear TDS_Master.json');
  assert(!alphaItinClearRe.test(alphaSource), 'Alpha.js must not clear Itin_Master.json');
}

function testGenerationPropagation() {
  const activeGen = 'gen:1700000000:ab12';
  const files = {};
  files[MANIFEST] = JSON.stringify({ schemaVersion: 1, activeGeneration: activeGen, previousGeneration: null, publishedAt: nowSec, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_1700000000_ab12.json', masterPath: DATA + 'TDS_Master.gen_1700000000_ab12.json', itineraryPath: DATA + 'Itin_Master.gen_1700000000_ab12.json', eventCount: 0, legCount: 0, itineraryCount: 0, generationHistory: [activeGen], state: 'committed' });
  files[DATA + 'TDS_Master.gen_1700000000_ab12.json'] = '[]';
  files[DATA + 'Itin_Master.gen_1700000000_ab12.json'] = '[]';
  files[DATA + 'TDS_Events.gen_1700000000_ab12.json'] = '[]';

  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: files, globals: { Current_Status: 'Idle', TDS_Active_Generation: activeGen }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  const idleFlash = store.flashLog.find(function (f) { return f.indexOf('IDLE_SYNC_ENGAGED') !== -1; });
  assert(idleFlash, 'expected IDLE_SYNC_ENGAGED flash');
  assert.strictEqual(JSON.parse(idleFlash).generationId, activeGen, 'Dispatcher idle flash must propagate active generation');
}

function testPlaceholderSandboxLiveBase() {
  const activeGen = 'gen:1700000000:ab12';
  const itinJson = JSON.stringify([{ tripId: 'stale_away', targetEventId: 'e1', mode: 'DRIVE', pitstopState: 'handled', departUnix: nowSec - 3600, arriveUnix: nowSec - 1800 }]);
  const masterJson = JSON.stringify([{ id: 'e1', start: nowSec + 3600, end: nowSec + 7200, duration: 3600, title: 'Future', loc: 'Work', coords: '52.0,-2.0' }]);
  const baseGeocodes = [nowSec.toString(), (nowSec + 86400).toString(), '51.9,-2.1', '0', 'Home', '', 'home_base'].join('~');
  const files = {
    [DATA + 'Itin_Master.json']: itinJson,
    [DATA + 'TDS_Master.json']: masterJson,
    [DATA + 'TDS_Base_Geocodes.txt']: baseGeocodes,
    [DATA + 'TDS_Overrides.json']: '{}',
    [DATA + 'Temp_Route_Cache.txt']: '',
    [DATA + 'RouteCache.txt']: ''
  };
  const globals = {
    User_At_Base: 'true',
    Base_Arrival_Unix: nowSec.toString(),
    User_Loc: '51.9,-2.1',
    Home_Coords: '51.9,-2.1',
    Current_Status: '',
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5',
    Max_Walk_Meters: '8046',
    Daily_Walk_Meters: '0',
    Live_Traffic_Threshold: '7200',
    Car_Connected: 'false',
    TDS_Active_Generation: activeGen
  };
  const locals = { idx: '1', vcar_loc: '51.9,-2.1', virtual_time: String(nowSec), virtual_loc: '51.9,-2.1' };
  const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
  const { sandbox, store } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  runScript(SANDBOX, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  const flash = store.flashLog.find(function (f) { return f.indexOf('LIVE_BASE_OVERRIDES_LEGACY_ORIGIN') !== -1; });
  assert(flash, 'expected LIVE_BASE_OVERRIDES_LEGACY_ORIGIN flash');
  assert.strictEqual(JSON.parse(flash).generationId, activeGen, 'Sandbox live-base flash must propagate active generation');
}

function testPlaceholderSandboxPolicyFallback() {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'Sandbox_Engine.js'), 'utf8');
  const idx = source.indexOf('DEPARTURE_POLICY_FALLBACK_USED');
  assert(idx !== -1, 'Sandbox must contain DEPARTURE_POLICY_FALLBACK_USED log site');
  const snippet = source.substring(Math.max(0, idx - 200), idx + 60);
  assert(snippet.indexOf("generationId: global('TDS_Active_Generation') || null") !== -1, 'Sandbox DEPARTURE_POLICY_FALLBACK_USED must read global TDS_Active_Generation');
}

function testPlaceholderDispatcherStale() {
  const activeGen = 'gen:1700000000:ab12';
  const files = {};
  files[MANIFEST] = JSON.stringify({ schemaVersion: 1, activeGeneration: activeGen, previousGeneration: null, publishedAt: nowSec, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_1700000000_ab12.json', masterPath: DATA + 'TDS_Master.gen_1700000000_ab12.json', itineraryPath: DATA + 'Itin_Master.gen_1700000000_ab12.json', eventCount: 1, legCount: 1, itineraryCount: 1, generationHistory: [activeGen], state: 'committed' });
  files[DATA + 'TDS_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'stale', start: nowSec - 18000, end: nowSec - 14400 }]);
  files[DATA + 'Itin_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ tripId: 'stale', mode: 'DRIVE', departUnix: nowSec - 18000, arriveUnix: nowSec - 14400, targetTitle: 'Past', targetCoords: '52.0,-2.0' }]);
  files[DATA + 'TDS_Events.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'stale' }]);
  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: files, globals: { Current_Status: 'Idle', TDS_Active_Generation: activeGen }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  const flash = store.flashLog.find(function (f) { return f.indexOf('STALE_TRIP_REJECTED') !== -1; });
  assert(flash, 'expected STALE_TRIP_REJECTED flash');
  assert.strictEqual(JSON.parse(flash).generationId, activeGen, 'Dispatcher stale flash must propagate active generation');
}

function testPlaceholderDispatcherIdle() {
  const activeGen = 'gen:1700000000:ab12';
  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const { sandbox, store } = createSandbox({ files: {}, globals: { Current_Status: 'Idle', TDS_Active_Generation: activeGen }, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, sandbox, store);
  if (store.runError) throw new Error(store.runError.message);
  const flash = store.flashLog.find(function (f) { return f.indexOf('IDLE_SYNC_ENGAGED') !== -1; });
  assert(flash, 'expected IDLE_SYNC_ENGAGED flash');
  assert.strictEqual(JSON.parse(flash).generationId, activeGen, 'Dispatcher idle flash must propagate active generation');
}

function testManifestLastWriteOrder() {
  const c = { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] };
  const r = runPub({}, c);
  assert.match(r.result, ID_RE);
  const enc = r.result.replace(/:/g, '_');
  const expectedPaths = [
    DATA + 'TDS_Events.' + enc + '.json',
    DATA + 'TDS_Master.' + enc + '.json',
    DATA + 'Itin_Master.' + enc + '.json',
    MANIFEST
  ];
  const firstWrites = [];
  const seen = {};
  for (let i = 0; i < r.store.writeOrder.length; i++) {
    const p = r.store.writeOrder[i];
    if (expectedPaths.indexOf(p) !== -1 && !seen[p]) {
      firstWrites.push(p);
      seen[p] = true;
    }
  }
  assert.deepStrictEqual(firstWrites, expectedPaths, 'Publisher must write events -> master -> itinerary -> manifest before any prune manifest update');
}

function testPruneDeletesOldGenerations() {
  const ids = [];
  let files = {};
  let finalStore;
  for (let i = 0; i < 6; i++) {
    const r = runPub(files, { events: [{ n: i }], master: [{ n: i }], itinerary: [{ n: i }] });
    ids.push(r.result);
    files = r.store.files;
    finalStore = r.store;
  }
  const oldEnc = ids[0].replace(/:/g, '_');
  const expectedDeletes = [
    DATA + 'TDS_Events.' + oldEnc + '.json',
    DATA + 'TDS_Master.' + oldEnc + '.json',
    DATA + 'Itin_Master.' + oldEnc + '.json'
  ];
  const actualDeletes = expectedDeletes.filter(function (p) {
    return files[p] === undefined;
  });
  assert.deepStrictEqual(actualDeletes, expectedDeletes, 'prune must delete the oldest generation files');
  assert(finalStore.deleteOrder.some(function (p) { return p === expectedDeletes[0]; }), 'deleteOrder must record the events file deletion');
}

function testReadBackRejectsTornWrite() {
  const c = { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] };
  const r = runPub({}, c, { tornWrites: ['TDS_Events.gen_'] });
  assert(r.result.indexOf('ERROR:') === 0, 'torn events write should fail the generation');
  const tornPath = r.store.writeOrder.find(function (p) { return p.indexOf('TDS_Events.gen_') !== -1; });
  assert(tornPath, 'a torn events file should have been written');
  const fullContent = JSON.stringify(c.events);
  const storedContent = r.store.files[tornPath];
  assert(storedContent && storedContent.length < fullContent.length, 'read-back must return partial bytes for a torn write');
  assert.strictEqual(r.sandbox.global('TDS_Active_Generation'), '', 'active generation must be cleared on torn write failure');
}

function testCompilerRejectsZeroDurationLeg() {
  const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');
  const futureEventStart = nowSec + 3600;
  const masterJson = JSON.stringify([{
    id: 'zero_abc123',
    start: futureEventStart,
    end: futureEventStart + 3600,
    duration: 3600,
    title: 'Zero Event',
    desc: '',
    loc: 'Work',
    coords: '52.1,-2.2'
  }]);
  const locals = {
    block_queue: makeEnvelope([makeTypedRow({
      rowType: 'EVENT',
      title: 'Zero Event',
      coords: '52.1,-2.2',
      mode: 'DRIVE',
      displayTime: futureEventStart,
      departTime: futureEventStart,
      pitstopState: 'false',
      apiTimeType: 'DEPART',
      apiTimeUnix: futureEventStart,
      evId: 'zero_abc123',
      evLoc: 'Work',
      engineLateMins: 0,
      currentLegStable: false,
      dropinStatusFlag: 'none',
      safeDesc: '',
      adHoc: [],
      departurePolicy: 'JIT',
      planningDay: '2023-11-14',
      originSource: 'LIVE_BASE'
    })]),
    api_duration_secs: '0',
    api_distance_miles: '0',
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
  assert(m && m.state === 'committed', 'Compiler should still publish a generation');
  assert.strictEqual(m.itineraryCount, 0, 'zero-duration travel leg must not be published');
  const itin = JSON.parse(store.files[m.itineraryPath]);
  assert.strictEqual(itin.length, 0, 'published itinerary must be empty');
  const flash = store.flashLog.find(function (f) { return f.indexOf('ZERO_DURATION_LEG_REJECTED') !== -1; });
  assert(flash, 'Compiler should log ZERO_DURATION_LEG_REJECTED');
  assert.strictEqual(JSON.parse(flash).tripId, 'zero_abc123');
}

function testPublisherConsidersRetentionHistory() {
  let files = {};
  const ids = [];
  // Publish PHASE2_RETENTION generations to fill the history window.
  for (let i = 0; i < 5; i++) {
    const r = runPub(files, { events: [{ n: i }], master: [{ n: i }], itinerary: [{ n: i }] }, {}, function () { return i / 0x10000; });
    assert.match(r.result, ID_RE);
    ids.push(r.result);
    files = r.store.files;
  }
  const retainedId = ids[0]; // gen:1700000000:0000
  // Force the first mint attempt to collide with the retained ID, then choose a fresh suffix.
  let attempts = 0;
  const r = runPub(files, { events: [{ n: 5 }], master: [{ n: 5 }], itinerary: [{ n: 5 }] }, {}, function () {
    attempts++;
    return attempts === 1 ? 0 / 0x10000 : 5 / 0x10000;
  });
  assert.strictEqual(r.result, 'gen:' + nowSec + ':0005', 'publisher must skip a retained generation id and mint a fresh one');
  const m = manifest(r.store);
  assert(m && m.state === 'committed', 'manifest must be committed after resolving the collision');
}

function testPublisherPreservesGenIdOnFailure() {
  const priorFiles = prior();
  const expectedGen = 'gen:' + nowSec + ':ab12';
  // Force a known ID, then make the manifest write torn so publish fails inside the try.
  const r = runPub(priorFiles, { events: [{ id: 'e1' }], master: [{ id: 'l1' }], itinerary: [{ tripId: 't1' }] }, { tornWrites: ['TDS_Run_Manifest.json'] }, function () { return 0xab12 / 0x10000; });
  assert(r.result.indexOf('ERROR:') === 0, 'torn manifest write should fail publish');
  const rawManifest = r.store.files[MANIFEST];
  assert(rawManifest && rawManifest.indexOf('"generationId":"' + expectedGen + '"') !== -1, 'failed manifest must preserve the minted generationId');

  // A subsequent successful publish must mint a new ID, not reuse the failed one.
  const m = readJsonFromStore(r.store, MANIFEST) || {};
  const files = {};
  files[MANIFEST] = JSON.stringify(m);
  const r2 = runPub(files, { events: [{ id: 'e2' }], master: [{ id: 'l2' }], itinerary: [{ tripId: 't2' }] }, {}, function () { return 0xab13 / 0x10000; });
  assert.strictEqual(r2.result, 'gen:' + nowSec + ':ab13', 'next success must mint a new generationId');
}

function readJsonFromStore(store, path) {
  const raw = store.files[path];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function activeGenFiles() {
  const activeGen = 'gen:1700000000:ab12';
  const files = {};
  files[MANIFEST] = JSON.stringify({ schemaVersion: 1, generationId: activeGen, activeGeneration: activeGen, previousGeneration: null, publishedAt: nowSec, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_1700000000_ab12.json', masterPath: DATA + 'TDS_Master.gen_1700000000_ab12.json', itineraryPath: DATA + 'Itin_Master.gen_1700000000_ab12.json', eventCount: 1, legCount: 1, itineraryCount: 1, generationHistory: [activeGen], state: 'committed' });
  files[DATA + 'TDS_Events.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'evt1' }]);
  files[DATA + 'TDS_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ id: 'evt1' }]);
  return files;
}

function publishPar1(store, candidate) {
  const nextLocals = Object.assign({}, store.locals);
  nextLocals['par1'] = JSON.stringify(candidate);
  const { sandbox: pubBox, store: pubStore } = createSandbox({ files: store.files, locals: nextLocals, nowMs: nowSec * 1000 });
  // Identify the Generation Publisher so its reorder-queue drain/clear passes
  // the mock ownership guard.
  pubBox.__currentScriptPath = PUBLISHER;
  runScript(PUBLISHER, pubBox, pubStore);
  pubBox.__currentScriptPath = '';
  if (pubStore.runError) throw new Error(pubStore.runError.message);
  return pubStore;
}

function testDepartNowCommandAdapter() {
  // Phase 4 Slice B (REQ-4ADAPTER-3): Depart Now is a typed command adapter.
  // It stages DEPART_NOW (command name + payload) and never stages a publish
  // candidate or writes masters; the reducer applies the lifecycle change to
  // only the selected trip.
  const DEPART_NOW = path.resolve(__dirname, '..', 'Depart_Now.js');
  const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');
  const activeGen = 'gen:1700000000:ab12';
  const files = activeGenFiles();
  files[DATA + 'Itin_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ tripId: 'leg1', targetEventId: 'evt1', mode: 'DRIVE', departUnix: nowSec + 3600, arriveUnix: nowSec + 5400, durationSecs: 1800, latenessMins: 5, bufferMins: 10, targetTitle: 'Work' }]);
  files[DATA + 'TDS_Trip_State.json'] = JSON.stringify({
    schemaVersion: 1, revision: 0, generationId: activeGen, currentOrigin: 'PLANNED',
    currentPlanningDay: '', userAtBase: false, baseArrivalUnix: null, latenessHalt: false,
    currentStatus: '', manualReturnCompleted: false,
    trips: { leg1: { tripId: 'leg1', lifecycleState: 'PLANNED', departUnix: nowSec + 3600, arriveUnix: nowSec + 5400, durationSecs: 1800, currentPlanningDay: '2023-11-14' } },
    stops: {}, manualSessions: {}
  });

  const { sandbox: box, store: s } = createSandbox({ files: files, globals: { TDS_Active_Generation: activeGen }, nowMs: nowSec * 1000 });
  runScript(DEPART_NOW, box, s);
  if (s.runError) throw new Error(s.runError.message);

  assert(!s.writeLog.some(function (w) { return w.path === DATA + 'Itin_Master.json'; }), 'Depart_Now.js must not write Itin_Master.json directly');
  assert.strictEqual(box.local('par1'), 'DEPART_NOW', 'Depart Now must stage the typed DEPART_NOW command');
  const staged = JSON.parse(box.local('par2'));
  assert.strictEqual(staged.tripId, 'leg1', 'Depart Now must stage the selected leg trip id');
  assert.strictEqual(staged.at, nowSec, 'Depart Now must stage the departure unix timestamp');

  // The router delivers DEPART_NOW to the reducer, which changes only the
  // selected trip to IN_PROGRESS and records manual departure + separate
  // estimated arrival, preserving planned values.
  const { sandbox: rbox, store: rstore } = createSandbox({ files: s.files, globals: { TDS_Active_Generation: activeGen }, nowMs: nowSec * 1000 });
  rbox.__currentScriptPath = STATE_COMMAND;
  rbox.setLocal('par1', box.local('par1'));
  rbox.setLocal('par2', box.local('par2'));
  runScript(STATE_COMMAND, rbox, rstore);
  rbox.__currentScriptPath = '';
  if (rstore.runError) throw new Error(rstore.runError.message);
  assert.strictEqual(rbox.local('tds_state_owner'), 'Trip_State_Reducer', 'DEPART_NOW must route to the reducer');
  const state = JSON.parse(rstore.files[DATA + 'TDS_Trip_State.json']);
  assert.strictEqual(state.trips.leg1.lifecycleState, 'IN_PROGRESS', 'only the selected trip may become IN_PROGRESS');
  assert.strictEqual(state.trips.leg1.manualDeparture, true, 'selected trip must record manualDeparture');
  assert.strictEqual(state.trips.leg1.actualDepartUnix, nowSec, 'selected trip must record actualDepartUnix');
  assert.strictEqual(state.trips.leg1.estimatedArrivalUnix, nowSec + 1800, 'selected trip must record a separate estimated arrival');
  assert.strictEqual(state.trips.leg1.departUnix, nowSec + 3600, 'selected trip must preserve its planned departure');
}

function testReturnToBaseCommandAdapter() {
  // Phase 4 Slice B (REQ-4ADAPTER-4): Return to Base is a typed command
  // adapter. It stages RETURN_TO_BASE with an explicit policy and positive
  // route metrics and NEVER serializes or prepends a candidate itinerary; the
  // reducer records the unique manual trip and chains SESSION_OPEN to the
  // Manual Action Handler (sessions + manual trips files).
  const RETURN_TO_BASE = path.resolve(__dirname, '..', 'Return_to_Base.js');
  const STATE_COMMAND = path.resolve(__dirname, '..', 'TDS_State_Command.js');
  const activeGen = 'gen:1700000000:ab12';
  const files = activeGenFiles();
  files[DATA + 'Itin_Master.gen_1700000000_ab12.json'] = JSON.stringify([{ tripId: 'leg1', targetEventId: 'evt1', mode: 'DRIVE', departUnix: nowSec + 3600, arriveUnix: nowSec + 5400, targetTitle: 'Work' }]);

  const globals = {
    TDS_Return_Coords: '51.9,-2.1',
    TDS_Return_Mode: 'DRIVE',
    TDS_Return_Name: 'Home',
    User_Loc: '52.45,-2.1',
    Car_Loc: '52.45,-2.1',
    TDS_Active_Generation: activeGen
  };
  const { sandbox: box, store: s } = createSandbox({ files: files, globals: globals, nowMs: nowSec * 1000 });
  runScript(RETURN_TO_BASE, box, s);
  if (s.runError) throw new Error(s.runError.message);

  assert(!s.writeLog.some(function (w) { return w.path === DATA + 'Itin_Master.json'; }), 'Return_to_Base.js must not write Itin_Master.json directly');
  assert.strictEqual(box.local('par1'), 'RETURN_TO_BASE', 'Return to Base must stage the typed RETURN_TO_BASE command');
  const staged = JSON.parse(box.local('par2'));
  assert.strictEqual(staged.policy, 'MANUAL', 'RETURN_TO_BASE must carry an explicit return policy');
  assert(/^(action|manual_return)_[0-9a-z]+$/.test(staged.actionId) && /^manual_return_[0-9a-z]+$/.test(staged.tripId),
    'RETURN_TO_BASE must carry collision-safe underscore+base-36 ids');
  assert(staged.durationSecs > 0 && staged.distanceMiles > 0, 'RETURN_TO_BASE must carry positive route metrics');
  assert.strictEqual(staged.targetCoords, '51.9,-2.1', 'RETURN_TO_BASE must target the base');
  assert.strictEqual(s.writeLog.length, 0, 'Return to Base must not prepend a candidate or write any file');

  // Router chain: reducer records the manual trip, then the Manual Action
  // Handler commits the session + manual trip records. No itinerary changes.
  const { sandbox: rbox, store: rstore } = createSandbox({ files: s.files, globals: globals, nowMs: nowSec * 1000 });
  rbox.__currentScriptPath = STATE_COMMAND;
  rbox.setLocal('par1', box.local('par1'));
  rbox.setLocal('par2', box.local('par2'));
  runScript(STATE_COMMAND, rbox, rstore);
  rbox.__currentScriptPath = '';
  if (rstore.runError) throw new Error(rstore.runError.message);
  assert(rbox.local('return_value').indexOf('OK') === 0, 'RETURN_TO_BASE chain must be accepted: ' + rbox.local('return_value'));
  const state = JSON.parse(rstore.files[DATA + 'TDS_Trip_State.json']);
  assert(state.trips[staged.tripId] && state.trips[staged.tripId].legType === 'MANUAL_RETURN', 'reducer must record the manual trip');
  const sessions = JSON.parse(rstore.files[DATA + 'TDS_Action_Sessions.json']);
  assert(sessions.sessions[staged.actionId] && sessions.sessions[staged.actionId].status === 'ACTIVE', 'handler must open the session');
  const manualTrips = JSON.parse(rstore.files[DATA + 'TDS_Manual_Trips.json']);
  assert(manualTrips.trips[staged.tripId], 'handler must commit the manual trip record');
  assert(!rstore.writeLog.some(function (w) { return w.path.indexOf('TDS_Run_Manifest') !== -1; }), 'no generation may be published by the return flow');
}

function testEndToEndFlow() {
  // Full live flow: Alpha ingests calendar events, Finaliser stages them,
  // Compiler assembles the leg, Publisher commits the generation, and
  // Dispatcher/Dashboard/Sandbox read the committed generation.
  const ALPHA = path.resolve(__dirname, '..', 'Alpha.js');
  const FINALISER = path.resolve(__dirname, '..', 'Finaliser.js');
  const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');
  const DISPATCHER = path.resolve(__dirname, '..', 'Dispatcher.js');
  const DASHBOARD = path.resolve(__dirname, '..', 'Dashboard.js');
  const SANDBOX = path.resolve(__dirname, '..', 'Sandbox_Engine.js');

  const futureEventStart = nowSec + 3600;
  const durationSecs = 1800;
  const locals = {
    ce_title1: 'Work',
    ce_description1: '',
    ce_event_id1: 'evt1_lkj000',
    ce_start_time1: String(futureEventStart * 1000),
    ce_end_time1: String((futureEventStart + 3600) * 1000),
    ce_location1: 'Work'
  };
  const globals = {
    User_Loc: '51.9,-2.1',
    User_At_Base: 'true',
    Home_Coords: '51.9,-2.1',
    Arrival_Buffer_Mins: '5',
    Departure_Buffer_Mins: '5',
    Max_Walk_Meters: '8046',
    Daily_Walk_Meters: '0',
    Live_Traffic_Threshold: '7200',
    Car_Connected: 'false',
    Current_Status: 'Idle',
    TIMEMS: String(nowSec * 1000),
    Auto_Base_Hours: '3'
  };
  const files = {
    [DATA + 'TDS_Master.json']: '[]',
    [DATA + 'Itin_Master.json']: '[]',
    [DATA + 'TDS_Overrides.json']: '{}',
    [DATA + 'Geocode_Cache.json']: JSON.stringify({ work: '52.1,-2.2' })
  };

  const { sandbox: alphaBox, store: alphaStore } = createSandbox({ locals: locals, globals: globals, files: files, nowMs: nowSec * 1000 });
  runScript(ALPHA, alphaBox, alphaStore);
  if (alphaStore.runError) throw new Error(alphaStore.runError.message);
  const tempEvents = alphaBox.local('tds_temp_json');
  assert(tempEvents && JSON.parse(tempEvents).length > 0, 'Alpha should output staged events');

  const { sandbox: finBox, store: finStore } = createSandbox({
    locals: { tds_temp_json: tempEvents },
    globals: globals,
    files: alphaStore.files,
    nowMs: nowSec * 1000
  });
  runScript(FINALISER, finBox, finStore);
  if (finStore.runError) throw new Error(finStore.runError.message);
  let m = manifest(finStore);
  assert(m && m.state === 'committed', 'Finaliser should publish a committed generation');

  const compilerLocals = {
    block_queue: makeEnvelope([makeTypedRow({
      rowType: 'EVENT',
      title: 'Work',
      coords: '52.1,-2.2',
      mode: 'DRIVE',
      displayTime: futureEventStart,
      departTime: futureEventStart,
      pitstopState: 'false',
      apiTimeType: 'DEPART',
      apiTimeUnix: futureEventStart,
      evId: 'evt1_lkj000',
      evLoc: 'Work',
      engineLateMins: 0,
      currentLegStable: false,
      dropinStatusFlag: 'none',
      safeDesc: '',
      adHoc: [],
      departurePolicy: 'JIT',
      planningDay: '2023-11-14',
      originSource: 'LIVE_BASE'
    })]),
    api_duration_secs: String(durationSecs),
    api_distance_miles: '15',
    api_transit_steps: '',
    virtual_time: String(nowSec - 60)
  };
  const { sandbox: compBox, store: compStore } = createSandbox({
    locals: compilerLocals,
    globals: Object.assign({}, globals, { TDS_Active_Generation: finBox.global('TDS_Active_Generation') }),
    files: finStore.files,
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, compBox, compStore);
  if (compStore.runError) throw new Error(compStore.runError.message);
  m = manifest(compStore);
  assert(m && m.state === 'committed', 'Compiler should publish a committed generation');
  assert.strictEqual(m.eventCount, 1, 'Compiler generation should contain one event');
  assert.strictEqual(m.itineraryCount, 1, 'Compiler generation should contain one itinerary leg');
  const itin = JSON.parse(compStore.files[m.itineraryPath]);
  assert.strictEqual(itin[0].departurePolicy, 'JIT', 'Compiler should preserve explicit departure policy');

  const readerGlobals = Object.assign({}, globals, { TDS_Active_Generation: compBox.global('TDS_Active_Generation') });
  const { sandbox: dispBox, store: dispStore } = createSandbox({ files: compStore.files, globals: readerGlobals, nowMs: nowSec * 1000 });
  runScript(DISPATCHER, dispBox, dispStore);
  if (dispStore.runError) throw new Error(dispStore.runError.message);
  assert.strictEqual(dispBox.local('itin_mode1'), 'DRIVE', 'Dispatcher should read the committed DRIVE leg');

  const { sandbox: dashBox, store: dashStore } = createSandbox({ files: compStore.files, globals: readerGlobals, nowMs: nowSec * 1000 });
  runScript(DASHBOARD, dashBox, dashStore);
  if (dashStore.runError) throw new Error(dashStore.runError.message);
  const btnCount = parseInt(dashBox.local('btn_count'), 10);
  assert(btnCount > 0, 'Dashboard should render at least one action button from the committed generation');

  const sandboxLocals = { idx: '1', vcar_loc: '51.9,-2.1', virtual_time: String(nowSec), virtual_loc: '51.9,-2.1' };
  const baseGeocodes = [nowSec.toString(), (nowSec + 86400).toString(), '51.9,-2.1', '0', 'Home', '', 'home_base'].join('~');
  const sandboxFiles = Object.assign({}, compStore.files, {
    [DATA + 'TDS_Base_Geocodes.txt']: baseGeocodes,
    [DATA + 'Temp_Route_Cache.txt']: '',
    [DATA + 'RouteCache.txt']: ''
  });
  const { sandbox: sboxBox, store: sboxStore } = createSandbox({ locals: sandboxLocals, globals: readerGlobals, files: sandboxFiles, nowMs: nowSec * 1000 });
  runScript(SANDBOX, sboxBox, sboxStore);
  if (sboxStore.runError) throw new Error(sboxStore.runError.message);
  const liveBaseFlash = sboxStore.flashLog.find(function (f) { return f.indexOf('LIVE_BASE_OVERRIDES_LEGACY_ORIGIN') !== -1; });
  assert(liveBaseFlash, 'Sandbox should emit LIVE_BASE_OVERRIDES_LEGACY_ORIGIN when live base overrides a non-base leg');
  assert.strictEqual(JSON.parse(liveBaseFlash).generationId, compBox.global('TDS_Active_Generation'), 'Sandbox flash must propagate active generation');
}

try {
  testResolver();
  testId();
  testGenIdParsing();
  testPublish();
  testSupersedingPublication();
  testFailures();
  testRetention();
  testFirstCommitNoPrune();
  testMigration();
  testRollbackRestoresLegacy();
  testCompilerCutover();
  testCompilerRejectsZeroDurationLeg();
  testFinaliserCutover();
  testReaderFallback();
  testReadersRequireCommittedState();
  testEmptyFallback();
  testCutoverProof();
  testReorderTiming();
  testStaleReorderRejection();
  testGatekeeperEmitsCommand();
  testApiParserEmitsCommand();
  testRule8aOwnership();
  testGenerationPropagation();
  testRestartClearsGeneration();
  testPlaceholderSandboxLiveBase();
  testPlaceholderSandboxPolicyFallback();
  testPlaceholderDispatcherStale();
  testPlaceholderDispatcherIdle();
  testDepartNowCommandAdapter();
  testReturnToBaseCommandAdapter();
  testManifestLastWriteOrder();
  testPruneDeletesOldGenerations();
  testReadBackRejectsTornWrite();
  testPublisherConsidersRetentionHistory();
  testPublisherPreservesGenIdOnFailure();
  testEndToEndFlow();
  console.log('PASS: atomic-publication: publisher and resolver contract OK');
} catch (e) {
  fail(e.message);
}
