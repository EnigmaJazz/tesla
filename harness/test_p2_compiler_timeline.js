process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox, makeEnvelope, makeTypedRow } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1700000000;
const DATA = 'Tasker/Tesla/Data/';
const COMPILER = path.resolve(__dirname, '..', 'Compiler.js');
const eventIds = ['event_A_kx8f00', 'event_B_kx8f00', 'event_C_kx8f00'];
const master = eventIds.map(function (id, index) {
  return { id: id, start: nowSec + 3600 + index * 3600, end: nowSec + 7200 + index * 3600, duration: 0, title: 'Event ' + index, desc: '', loc: 'Work', coords: '52.0,-2.0' };
});
function row(id, fields) {
  return makeTypedRow(Object.assign({
    rowType: 'EVENT', title: id, coords: '52.0,-2.0', mode: 'DRIVE',
    displayTime: nowSec + 3600, departTime: nowSec + 3600,
    apiTimeType: 'DEPART', apiTimeUnix: nowSec + 3600, evId: id,
    evLoc: 'Work', engineLateMins: 0, currentLegStable: false,
    dropinStatusFlag: 'attached_dropin', safeDesc: '', adHoc: [],
    routeDurationSecs: 600, routeDistanceMiles: 5,
    departurePolicy: 'ASAP', planningDay: '2026-09-26', originSource: 'LIVE_BASE'
  }, fields || {}));
}
const rows = [
  row(eventIds[0]),
  row(eventIds[1], { routeDurationSecs: null, routeDistanceMiles: null, adHoc: [2] }),
  row(eventIds[2], { dropinStatusFlag: 'none', adHoc: [] })
];
let carriedFiles = {
  [DATA + 'TDS_Master.json']: JSON.stringify(master),
  [DATA + 'Itin_Master.json']: '[]',
  [DATA + 'TDS_Overrides.json']: '{}'
};
let store;
rows.forEach(function (typedRow) {
  const { sandbox, store: runStore } = createSandbox({
    locals: { block_queue: makeEnvelope([typedRow], { eof: true, skipIdxUntil: 1 }), virtual_time: String(nowSec - 60), api_duration_secs: '', api_distance_miles: '', api_transit_steps: '' },
    globals: { User_At_Base: 'true', User_Loc: '51.9,-2.1', Arrival_Buffer_Mins: '5', Departure_Buffer_Mins: '5' },
    files: carriedFiles,
    nowMs: nowSec * 1000
  });
  runScript(COMPILER, sandbox, runStore);
  assert.strictEqual(runStore.runError, undefined, 'Compiler must not throw for ' + typedRow.evId);
  carriedFiles = runStore.files;
  store = runStore;
});
const manifest = JSON.parse(store.files[DATA + 'TDS_Run_Manifest.json']);
const itinerary = JSON.parse(store.files[manifest.itineraryPath]);
const followingLeg = itinerary.find(function (leg) { return leg.targetEventId === eventIds[2]; });
assert(followingLeg, 'the leg after the rejected zero-duration leg must publish');
assert.strictEqual(followingLeg.departUnix, nowSec + 600, 'following leg departure must not include rejected stop padding');
const rejected = store.flashLog.map(function (entry) { return JSON.parse(entry); }).find(function (entry) { return entry.code === 'ZERO_DURATION_LEG_REJECTED'; });
assert(rejected, 'the middle zero-duration leg must be rejected');
assert.strictEqual(rejected.details.withheldSeconds, 120, 'rejection log must expose the withheld dwell/padding seconds');
console.log('PASS: p2 compiler timeline — rejected zero-duration leg does not advance published itinerary time');
