// Behavioral drift guard for standalone local-day helper copies.
// The probe mutates only an in-memory source copy; production files are read-only.
process.env.TZ = 'Europe/London';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = ['Alpha.js', 'Sandbox_Engine.js', 'Finaliser.js', 'Compiler.js', 'Dispatcher.js', 'Cluster_Builder.js'];
const HARNESS_DAY_UTILS = path.join(__dirname, 'day_utils.js');
const helperNames = ['localPlanningDay', 'localDayBoundaryUnix', 'isSameLocalDay'];
const instants = [
  Date.parse('2027-03-28T00:30:00Z') / 1000,
  Date.parse('2026-10-25T01:30:00Z') / 1000,
  Date.parse('2026-07-14T23:00:00Z') / 1000,
  Date.parse('2026-07-14T22:59:59Z') / 1000,
  Date.parse('2026-12-31T23:59:59Z') / 1000,
  Date.parse('2024-02-29T12:00:00Z') / 1000
];

function extractFunction(source, name) {
  const match = new RegExp('function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) return null;
  const start = match.index;
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed helper ' + name);
}

function loadFunction(source, name) {
  const context = { Date: Date, TWO_DIGIT_PAD_WIDTH: 2 };
  vm.runInNewContext(source + '; this.helper = ' + name + ';', context);
  return context.helper;
}

const files = SCRIPTS.map(function (file) { return { name: file, source: fs.readFileSync(path.join(ROOT, file), 'utf8') }; });
files.push({ name: 'harness/day_utils.js', source: fs.readFileSync(HARNESS_DAY_UTILS, 'utf8') });

for (const helperName of helperNames) {
  const copies = files.map(function (file) {
    const source = extractFunction(file.source, helperName);
    return source ? { name: file.name, source: source, fn: loadFunction(source, helperName) } : null;
  }).filter(Boolean);
  assert(copies.length >= 2, helperName + ' must have multiple standalone copies');
  const samples = helperName === 'isSameLocalDay'
    ? [[instants[0], instants[0]], [instants[0], instants[1]]].concat(instants.slice(0, -1).map(function (value, index) { return [value, instants[index + 1]]; }))
    : instants.map(function (value) { return [value]; });
  const expected = samples.map(function (args) { return copies[0].fn.apply(null, args); });
  copies.forEach(function (copy) {
    assert.deepStrictEqual(samples.map(function (args) { return copy.fn.apply(null, args); }), expected,
      helperName + ' differs in ' + copy.name);
  });

  // Sensitivity proof: mutate only the extracted in-memory first copy.
  const drifted = copies[0].source.replace('getDate()', 'getDate() + 1');
  assert.notStrictEqual(drifted, copies[0].source, helperName + ' probe must alter the scratch source');
  const driftFn = loadFunction(drifted, helperName);
  assert.notDeepStrictEqual(samples.map(function (args) { return driftFn.apply(null, args); }), expected,
    helperName + ' guard must detect a mutated scratch copy');
}

console.log('PASS: day-helper-drift — behavioral agreement across all present copies; in-memory drift probe detected');
