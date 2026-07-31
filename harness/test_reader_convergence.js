// Phase 3 PR-E test: reader convergence and explicit origin.
// Verifies that TDS_Helper.readActiveGeneration and readOrigin work
// correctly across the active/prior/legacy fallback chain.
process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const TDS_HELPER_PATH = path.resolve(__dirname, '..', 'TDS_Helper.js');
const GEN = 'gen:1700000000:ab12';
const MANIFEST = 'Tasker/Tesla/Data/TDS_Run_Manifest.json';
const MASTER = 'Tasker/Tesla/Data/TDS_Master.json';
const ITIN = 'Tasker/Tesla/Data/Itin_Master.json';
const MASTER_NEW = 'Tasker/Tesla/Data/TDS_Master.gen_1700000000_ab12.json';
const ITIN_NEW = 'Tasker/Tesla/Data/Itin_Master.gen_1700000000_ab12.json';
const STATE = 'Tasker/Tesla/Data/TDS_Trip_State.json';

function make() { return createSandbox({ nowMs: 1700000000000 }); }
function runHelper(sandbox, store, par1) {
  sandbox.setLocal('par1', par1);
  runScript(TDS_HELPER_PATH, sandbox, store);
  return sandbox.local('return_value');
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.log('FAIL: reader-convergence: ' + name + ' — ' + e.message); failed++; }
}

t('readActiveGeneration returns [] when nothing exists', () => {
  const { sandbox, store } = make();
  const r = runHelper(sandbox, store, 'readActiveGeneration:master');
  assert.deepEqual(JSON.parse(r || '[]'), [], 'no files → []');
});

t('readActiveGeneration returns manifest masterPath data', () => {
  const { sandbox, store } = make();
  const data = [{ id: 'a' }];
  store.files[MASTER_NEW] = JSON.stringify(data);
  sandbox.writeFile(MANIFEST, JSON.stringify({
    schemaVersion: 1, state: 'committed',
    activeGeneration: GEN, previousGeneration: '',
    masterPath: MASTER_NEW, itineraryPath: ''
  }));
  const r = runHelper(sandbox, store, 'readActiveGeneration:master');
  assert.deepEqual(JSON.parse(r), data, 'must return manifest data');
});

t('readActiveGeneration falls back to previousGeneration', () => {
  const { sandbox, store } = make();
  const data = [{ id: 'prev' }];
  const PREV = 'gen:1690000000:ff99';
  const MASTER_PREV = 'Tasker/Tesla/Data/TDS_Master.gen_1690000000_ff99.json';
  store.files[MASTER_PREV] = JSON.stringify(data);
  sandbox.writeFile(MANIFEST, JSON.stringify({
    schemaVersion: 1, state: 'committed',
    activeGeneration: '', previousGeneration: PREV,
    masterPath: '', itineraryPath: ''
  }));
  const r = runHelper(sandbox, store, 'readActiveGeneration:master');
  assert.deepEqual(JSON.parse(r), data, 'must return previous generation data');
});

t('readActiveGeneration falls back to legacy TDS_Master.json', () => {
  const { sandbox, store } = make();
  const data = [{ id: 'legacy' }];
  store.files[MASTER] = JSON.stringify(data);
  sandbox.writeFile(MANIFEST, JSON.stringify({ schemaVersion: 1, state: 'committed', activeGeneration: '', previousGeneration: '' }));
  const r = runHelper(sandbox, store, 'readActiveGeneration:master');
  assert.deepEqual(JSON.parse(r), data, 'must return legacy TDS_Master.json');
});

t('readOrigin returns PLANNED when no state file', () => {
  const { sandbox, store } = make();
  const r = runHelper(sandbox, store, 'readOrigin');
  assert.equal(r, 'PLANNED', 'no state file → PLANNED');
});

t('readOrigin returns state.currentOrigin', () => {
  const { sandbox, store } = make();
  store.files[STATE] = JSON.stringify({
    schemaVersion: 1, revision: 1, currentOrigin: 'LIVE_BASE',
    userAtBase: true, baseArrivalUnix: 1700000000
  });
  const r = runHelper(sandbox, store, 'readOrigin');
  assert.equal(r, 'LIVE_BASE', 'must return currentOrigin');
});

t('readOrigin returns PLANNED on missing currentOrigin', () => {
  const { sandbox, store } = make();
  store.files[STATE] = JSON.stringify({ schemaVersion: 1, revision: 0 });
  const r = runHelper(sandbox, store, 'readOrigin');
  assert.equal(r, 'PLANNED', 'missing currentOrigin → PLANNED');
});

t('readOrigin returns PLANNED on malformed state', () => {
  const { sandbox, store } = make();
  store.files[STATE] = '{not valid json';
  const r = runHelper(sandbox, store, 'readOrigin');
  assert.equal(r, 'PLANNED', 'malformed state → PLANNED');
});

t('readActiveGeneration itinerary falls back to legacy Itin_Master.json', () => {
  const { sandbox, store } = make();
  const data = [{ id: 'itin-legacy' }];
  store.files[ITIN] = JSON.stringify(data);
  sandbox.writeFile(MANIFEST, JSON.stringify({ schemaVersion: 1, state: 'committed', activeGeneration: '', previousGeneration: '' }));
  const r = runHelper(sandbox, store, 'readActiveGeneration:itinerary');
  assert.deepEqual(JSON.parse(r), data, 'must return legacy Itin_Master.json');
});

console.log('reader-convergence results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
