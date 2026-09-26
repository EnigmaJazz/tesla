// Geocode_Updater harness — device-side geocode-cache commit.
// Covers: happy-path merge + courtesy staging, key normalization, empty and
// unexpanded %http_data, invalid JSON, ZERO_RESULTS, corrupt-cache abort
// (file must survive byte-identical), write-failure injection, empty
// location, nonfinite coordinates, custom TESLA_CONFIG dataRoot (P1-1).

process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const UPDATER = path.resolve(__dirname, '..', 'Geocode_Updater.js');
const CACHE = "Tasker/Tesla/Data/Geocode_Cache.json";

const nowSec = 1700000000;
const okResponse = JSON.stringify({
  status: "OK",
  results: [{ geometry: { location: { lat: 51.95, lng: -2.05 } } }]
});

let failures = 0;
function fail(msg) { failures += 1; console.log('FAIL: geocode-updater — ' + msg); }

function make(httpData, locText, extra) {
  extra = extra || {};
  const locals = Object.assign({ http_data: httpData, loc_text: locText }, extra.locals || {});
  const { sandbox, store } = createSandbox({
    locals: locals,
    files: extra.files || {},
    nowMs: nowSec * 1000,
    failures: extra.failures || {}
  });
  runScript(UPDATER, sandbox, store);
  return store;
}

function logs(store) {
  return (store.flashLog || []).map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
}
function hasCode(store, code) {
  return logs(store).some(function (l) { return l.code === code; });
}
function logWith(store, code) {
  return logs(store).filter(function (l) { return l.code === code; });
}
function parsedCache(store) {
  const raw = store.files[CACHE];
  return raw ? JSON.parse(raw) : null;
}
function assertLogShape(l, code, severity) {
  assert.strictEqual(typeof l.timestamp, 'number', 'timestamp must be a number');
  assert.strictEqual(l.generationId, null, 'generationId must be null');
  assert.strictEqual(l.component, 'Geocode_Updater', 'component must be Geocode_Updater');
  assert.strictEqual(l.severity, severity, 'severity must be ' + severity);
  assert.strictEqual(l.code, code, 'code must be ' + code);
  assert.strictEqual(l.tripId, null, 'tripId must be null');
  assert(l.details && typeof l.details === 'object', 'details must be an object');
}

// T1: valid response + existing cache -> both keys, courtesy staging, info log.
try {
  const files = {};
  files[CACHE] = JSON.stringify({ old: '1,2' });
  const store = make(okResponse, '  New Place  ', { files: files });
  if (store.runError) fail('happy path threw: ' + store.runError.message);
  assert.strictEqual(store.locals['return_value'], 'ok:updated', 'return_value must be ok:updated');
  const cache = parsedCache(store);
  assert(cache, 'cache file must be written');
  assert.strictEqual(cache['old'], '1,2', 'existing key must be preserved');
  assert.strictEqual(cache['new place'], '51.95,-2.05', 'normalized key must hold the fixture coords');
  assert.strictEqual(store.locals['local_geo_cache'], JSON.stringify(cache), 'local_geo_cache must mirror the written cache');
  assert(logs(store).every(function (l) { return l.severity !== 'error'; }), 'happy path must not log errors');
  const upd = logWith(store, 'GEOCODE_CACHE_UPDATED');
  assert.strictEqual(upd.length, 1, 'exactly one GEOCODE_CACHE_UPDATED');
  assertLogShape(upd[0], 'GEOCODE_CACHE_UPDATED', 'info');
  assert.strictEqual(upd[0].details.key, 'new place', 'info details.key must be the normalized key');
  assert.strictEqual(upd[0].details.coords, '51.95,-2.05', 'info details.coords must be lat,lon');
  assert.strictEqual(upd[0].details.entryCount, 2, 'info details.entryCount must be 2');
} catch (e) { fail('happy path: ' + e.message); }

// T2: key normalization (mixed case + trailing space -> lowercase trim).
try {
  const store = make(okResponse, 'CaFe ');
  assert.strictEqual(store.locals['return_value'], 'ok:updated', 'return_value must be ok:updated');
  const cache = parsedCache(store);
  assert.strictEqual(cache['cafe'], '51.95,-2.05', 'CaFe  must normalize to cafe');
} catch (e) { fail('key normalization: ' + e.message); }

// T3: empty %http_data -> skip, no write, no logs.
try {
  const store = make('', 'Some Place');
  assert.strictEqual(store.locals['return_value'], 'skip:no_data', 'return_value must be skip:no_data');
  assert.strictEqual(store.files[CACHE], undefined, 'empty http_data must not write the cache');
  assert.strictEqual(store.flashLog.length, 0, 'empty http_data must not log anything');
} catch (e) { fail('empty http_data: ' + e.message); }

// T4: unexpanded "%http_data" -> skip, no write, no logs.
try {
  const store = make('%http_data', 'Some Place');
  assert.strictEqual(store.locals['return_value'], 'skip:no_data', 'return_value must be skip:no_data');
  assert.strictEqual(store.files[CACHE], undefined, 'unexpanded http_data must not write the cache');
  assert.strictEqual(store.flashLog.length, 0, 'unexpanded http_data must not log anything');
} catch (e) { fail('unexpanded http_data: ' + e.message); }

// T5: invalid JSON -> GEOCODE_RESPONSE_INVALID, no write.
try {
  const store = make('{oops', 'Some Place');
  assert.strictEqual(store.locals['return_value'], 'skip:invalid_json', 'return_value must be skip:invalid_json');
  const inv = logWith(store, 'GEOCODE_RESPONSE_INVALID');
  assert.strictEqual(inv.length, 1, 'exactly one GEOCODE_RESPONSE_INVALID');
  assertLogShape(inv[0], 'GEOCODE_RESPONSE_INVALID', 'warn');
  assert.strictEqual(typeof inv[0].details.reason, 'string', 'details.reason must be a string');
  assert.strictEqual(store.files[CACHE], undefined, 'invalid JSON must not write the cache');
} catch (e) { fail('invalid json: ' + e.message); }

// T6: ZERO_RESULTS (and missing results array) -> GEOCODE_RESPONSE_INVALID, no write.
try {
  const zeroStore = make(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), 'Some Place');
  assert.strictEqual(zeroStore.locals['return_value'], 'skip:no_result', 'return_value must be skip:no_result');
  const inv = logWith(zeroStore, 'GEOCODE_RESPONSE_INVALID');
  assert.strictEqual(inv.length, 1, 'exactly one GEOCODE_RESPONSE_INVALID');
  assert.strictEqual(inv[0].details.status, 'ZERO_RESULTS', 'details.status must be ZERO_RESULTS');
  assert.strictEqual(zeroStore.files[CACHE], undefined, 'ZERO_RESULTS must not write the cache');

  const noResultsStore = make(JSON.stringify({ status: 'OK' }), 'Some Place');
  assert.strictEqual(noResultsStore.locals['return_value'], 'skip:no_result', 'missing results array must skip');
  assert.strictEqual(noResultsStore.files[CACHE], undefined, 'missing results array must not write');
} catch (e) { fail('zero results: ' + e.message); }

// T7: corrupt existing cache -> abort, file byte-identical, no write attempted.
try {
  const files = {};
  files[CACHE] = '{oops';
  const store = make(okResponse, 'Some Place', { files: files });
  assert.strictEqual(store.locals['return_value'], 'abort:corrupt_cache', 'return_value must be abort:corrupt_cache');
  assert.strictEqual(store.files[CACHE], '{oops', 'corrupt cache must remain byte-identical (no overwrite)');
  assert(store.writeOrder.indexOf(CACHE) === -1, 'corrupt cache must never be written');
  const abort = logWith(store, 'GEOCODE_CACHE_CORRUPT_ABORT');
  assert.strictEqual(abort.length, 1, 'exactly one GEOCODE_CACHE_CORRUPT_ABORT');
  assertLogShape(abort[0], 'GEOCODE_CACHE_CORRUPT_ABORT', 'error');
  assert.strictEqual(typeof abort[0].details.reason, 'string', 'details.reason must be a string');
} catch (e) { fail('corrupt cache: ' + e.message); }

// T8: writeFile throws -> GEOCODE_CACHE_WRITE_FAILED.
try {
  const store = make(okResponse, 'Some Place', { failures: { writeThrows: ['Geocode_Cache.json'] } });
  assert.strictEqual(store.locals['return_value'], 'error:write_failed', 'return_value must be error:write_failed');
  const wf = logWith(store, 'GEOCODE_CACHE_WRITE_FAILED');
  assert.strictEqual(wf.length, 1, 'exactly one GEOCODE_CACHE_WRITE_FAILED');
  assertLogShape(wf[0], 'GEOCODE_CACHE_WRITE_FAILED', 'error');
  assert.strictEqual(typeof wf[0].details.reason, 'string', 'details.reason must be a string');
} catch (e) { fail('write failure: ' + e.message); }

// T9: empty / whitespace loc -> GEOCODE_EMPTY_LOCATION, no write.
try {
  const emptyStore = make(okResponse, '');
  assert.strictEqual(emptyStore.locals['return_value'], 'skip:empty_location', 'empty loc must skip');
  assert.strictEqual(emptyStore.files[CACHE], undefined, 'empty loc must not write the cache');
  const wsStore = make(okResponse, '   ');
  assert.strictEqual(wsStore.locals['return_value'], 'skip:empty_location', 'whitespace loc must skip');
  assert.strictEqual(wsStore.files[CACHE], undefined, 'whitespace loc must not write the cache');
  const el = logWith(emptyStore, 'GEOCODE_EMPTY_LOCATION');
  assert.strictEqual(el.length, 1, 'exactly one GEOCODE_EMPTY_LOCATION');
  assertLogShape(el[0], 'GEOCODE_EMPTY_LOCATION', 'warn');
} catch (e) { fail('empty location: ' + e.message); }

// T10: nonfinite coords (lat null) -> GEOCODE_RESPONSE_INVALID, no write.
try {
  const nonfinite = JSON.stringify({ status: 'OK', results: [{ geometry: { location: { lat: null, lng: -2.05 } } }] });
  const store = make(nonfinite, 'Some Place');
  assert.strictEqual(store.locals['return_value'], 'skip:nonfinite_coords', 'return_value must be skip:nonfinite_coords');
  assert.strictEqual(store.files[CACHE], undefined, 'nonfinite coords must not write the cache');
  const inv = logWith(store, 'GEOCODE_RESPONSE_INVALID');
  assert.strictEqual(inv.length, 1, 'exactly one GEOCODE_RESPONSE_INVALID');
  assert.strictEqual(inv[0].details.reason, 'nonfinite_coords', 'details.reason must be nonfinite_coords');
} catch (e) { fail('nonfinite coords: ' + e.message); }

// T11 (P1-1): a custom TESLA_CONFIG dataRoot must move the cache path with
// DATA_ROOT so the writer commits where Alpha/Finaliser read.
try {
  const customPath = 'Custom/Data/Geocode_Cache.json';
  const files = {};
  files['Tasker/Tesla/TESLA_CONFIG.json'] = JSON.stringify({ dataRoot: 'Custom/Data' });
  const store = make(okResponse, 'Some Place', { files: files });
  assert.strictEqual(store.locals['return_value'], 'ok:updated', 'custom dataRoot must still commit');
  const cache = JSON.parse(store.files[customPath] || 'null');
  assert(cache && cache['some place'] === '51.95,-2.05', 'custom dataRoot must receive the write');
  assert.strictEqual(store.files[CACHE], undefined, 'default path must not be written under a custom dataRoot');
} catch (e) { fail('custom dataRoot: ' + e.message); }

// T12: valid JSON arrays are corrupt cache values and must never be rewritten.
try {
  const files = {};
  files[CACHE] = '[]';
  const store = make(okResponse, 'Some Place', { files: files });
  assert.strictEqual(store.locals['return_value'], 'abort:corrupt_cache', 'array cache must abort as corrupt');
  assert.strictEqual(store.files[CACHE], '[]', 'array cache must remain byte-identical');
  assert.strictEqual(store.writeOrder.indexOf(CACHE), -1, 'array cache must not be written');
  assert(hasCode(store, 'GEOCODE_CACHE_CORRUPT_ABORT'), 'array cache must use the corrupt-cache log code');
} catch (e) { fail('array cache: ' + e.message); }

if (failures > 0) { console.log('FAIL: geocode-updater — ' + failures + ' scenario(s) failed'); process.exit(1); }
console.log('PASS: geocode-updater — merge+normalize, no-data/invalid/no-result skips, corrupt abort, write failure, empty loc, nonfinite coords, custom dataRoot');
process.exit(0);
