// Behavioral drift guard for the three inlined route-cache validators.
// All probes and extracted-source mutations stay in memory; production files are read-only.
process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const nowSec = 1700000000;

function extractFunction(source, name) {
  const match = new RegExp('function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error('Missing function ' + name);
  const start = match.index;
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed function ' + name);
}
function readSource(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

const rcmSource = readSource('Route_Cache_Manager.js');
const gkSource = readSource('Gatekeeper.js');
const sbSource = readSource('Sandbox_Engine.js');
const routeKeySources = [
  extractFunction(rcmSource, 'rcmRouteKey'),
  extractFunction(gkSource, 'gkRouteKey'),
  extractFunction(sbSource, 'sbRouteKey')
];
const routeFilters = [
  extractFunction(rcmSource, 'rcmFilterRouteEntries'),
  extractFunction(gkSource, 'readCacheJson'),
  extractFunction(sbSource, 'sbReadCacheJson')
];

function runFilter(index, raw) {
  const filePath = 'cache.json';
  const context = {
    Date: Date, Math: Math, Object: Object, JSON: JSON, isFinite: isFinite,
    RCM_WALK: 'WALK', CACHE_MODE_WALK: 'WALK', nowSec: nowSec,
    rcmLog: function () {},
    gkRejectCacheEntry: function () {}, sbRejectCacheEntry: function () {},
    readFile: function () { return raw; }
  };
  if (index === 0) {
    vm.runInNewContext(routeKeySources[0] + '\n' + routeFilters[0] + '; this.filter = rcmFilterRouteEntries;', context);
    let parsed = { entries: {} };
    try { if (raw) parsed = JSON.parse(raw); } catch (e) { parsed = { entries: {} }; }
    return context.filter(parsed, nowSec);
  }
  if (index === 1) {
    const tempKey = extractFunction(gkSource, 'gkTempKey');
    vm.runInNewContext(routeKeySources[1] + '\n' + tempKey + '\n' + routeFilters[1] + '; this.filter = readCacheJson;', context);
    const result = context.filter(filePath, nowSec, 'route');
    return result && result.entries;
  }
  const tempKey = extractFunction(sbSource, 'sbTempKey');
  vm.runInNewContext(routeKeySources[2] + '\n' + tempKey + '\n' + routeFilters[2] + '; this.filter = sbReadCacheJson;', context);
  return context.filter(filePath, 'route');
}

const baseEntry = {
  originCell: 'origin', destinationCell: 'destination', mode: 'DRIVE',
  meanDurationSecs: 600, sampleCount: 2, m2: 0, distanceMiles: 1.25,
  dayClass: 1, bucket: 2, createdAt: nowSec - 10, updatedAt: nowSec - 5,
  expiresAt: nowSec + 1000
};
const key = 'origin~~destination~~DRIVE~~2~~1';
const cases = [
  { name: 'valid', raw: function () { return JSON.stringify({ schemaVersion: 1, entries: { [key]: baseEntry } }); }, accepted: true },
  { name: 'expired', entry: { expiresAt: nowSec }, accepted: false },
  { name: 'nonpositive duration', entry: { meanDurationSecs: 0 }, accepted: false },
  { name: 'missing required field', omit: 'distanceMiles', accepted: false },
  { name: 'wrong-typed field', entry: { sampleCount: '2' }, accepted: false },
  { name: 'malformed JSON', raw: function () { return '{bad'; }, accepted: false },
  { name: 'empty cache', raw: function () { return ''; }, accepted: false },
  { name: 'absent cache', raw: function () { return null; }, accepted: false }
];

function rawFor(testCase) {
  if (testCase.raw) return testCase.raw();
  const entry = Object.assign({}, baseEntry, testCase.entry || {});
  if (testCase.omit) delete entry[testCase.omit];
  return JSON.stringify({ schemaVersion: 1, entries: { [key]: entry } });
}
function outcome(result) {
  const entries = result || {};
  const keys = Object.keys(entries);
  return { accepted: keys.length === 1 && keys[0] === key, value: keys.length ? entries[keys[0]] : null };
}

for (const testCase of cases) {
  const raw = rawFor(testCase);
  const results = [0, 1, 2].map(function (index) { return outcome(runFilter(index, raw)); });
  results.forEach(function (result, index) {
    assert.strictEqual(result.accepted, testCase.accepted,
      testCase.name + ' accept/reject mismatch in validator ' + index);
  });
  assert.deepStrictEqual(results[0], results[1], testCase.name + ' RCM/Gatekeeper outcome mismatch');
  assert.deepStrictEqual(results[0], results[2], testCase.name + ' RCM/Sandbox outcome mismatch');
}

// Sensitivity proof: replace only an extracted scratch validator's positive-duration
// condition and show the same shared nonpositive fixture now diverges.
const driftedFilter = routeFilters[0].replace('if (!(e.meanDurationSecs > 0))', 'if (false)');
assert.notStrictEqual(driftedFilter, routeFilters[0], 'probe must mutate only the in-memory extracted copy');
const driftContext = {
  Date: Date, Math: Math, Object: Object, JSON: JSON, isFinite: isFinite,
  RCM_WALK: 'WALK', rcmLog: function () {}
};
vm.runInNewContext(routeKeySources[0] + '\n' + driftedFilter + '; this.filter = rcmFilterRouteEntries;', driftContext);
const nonpositiveRaw = rawFor(cases[2]);
const driftOutcome = outcome(driftContext.filter(JSON.parse(nonpositiveRaw), nowSec));
assert.strictEqual(driftOutcome.accepted, true, 'shared nonpositive fixture must expose the mutated scratch validator');
assert.notDeepStrictEqual(driftOutcome, outcome(runFilter(1, nonpositiveRaw)), 'guard must detect scratch-copy drift');

console.log('PASS: cache-validation-drift — shared route-cache table agrees across RCM/Gatekeeper/Sandbox; scratch drift detected');
