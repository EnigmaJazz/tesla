// Phase 2 PR-A: TDS_Helper resolver contract (Publisher tests added in next commit).
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const MANIFEST = DATA + 'TDS_Run_Manifest.json';
const HELPER = path.resolve(__dirname, '..', 'TDS_Helper.js');

function seed(files) {
  const base = {};
  base[DATA + 'TDS_Master.json'] = '[]';
  base[DATA + 'Itin_Master.json'] = '[]';
  return Object.assign({}, base, files || {});
}
function make(files) {
  return createSandbox({ files: seed(files), nowMs: nowSec * 1000 });
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

  const priorId = 'gen:1699999999:0001';
  const priorFiles = {};
  priorFiles[MANIFEST] = JSON.stringify({ schemaVersion: 1, generationId: priorId, activeGeneration: priorId, previousGeneration: null, publishedAt: nowSec - 1, writer: 'Generation Publisher', eventsPath: DATA + 'TDS_Events.gen_1699999999_0001.json', masterPath: DATA + 'TDS_Master.gen_1699999999_0001.json', itineraryPath: DATA + 'Itin_Master.gen_1699999999_0001.json', eventCount: 1, legCount: 1, itineraryCount: 1, generationHistory: [priorId], state: 'failed' });
  priorFiles[DATA + 'TDS_Master.gen_1699999999_0001.json'] = JSON.stringify([{ id: 'p1' }]);
  priorFiles[DATA + 'Itin_Master.gen_1699999999_0001.json'] = JSON.stringify([{ tripId: 'pt1' }]);
  priorFiles[DATA + 'TDS_Events.gen_1699999999_0001.json'] = JSON.stringify([{ id: 'pe1' }]);
  assert.deepEqual(JSON.parse(runHelper(priorFiles, 'master')), [{ id: 'p1' }]);

  assert.deepEqual(JSON.parse(runHelper({}, 'master')), []);

  const { sandbox, store } = make();
  sandbox.setLocal('par1', 'master:0:id');
  sandbox.setLocal('par2', 'newValue');
  runScript(HELPER, sandbox, store);
  const rv = sandbox.local('return_value');
  assert(rv.indexOf('ERROR:') === 0 && rv.indexOf('setter is removed') !== -1, 'setter should be rejected');
}

try {
  testResolver();
  console.log('PASS: atomic-publication: resolver contract OK');
} catch (e) {
  fail(e.message);
}
