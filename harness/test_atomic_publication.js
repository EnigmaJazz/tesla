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

try {
  testResolver();
  testId();
  testPublish();
  testFailures();
  testRetention();
  testMigration();
  console.log('PASS: atomic-publication: publisher and resolver contract OK');
} catch (e) {
  fail(e.message);
}
