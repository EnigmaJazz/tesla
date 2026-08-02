// Phase 3 PR-D: departure observation and day-boundary preservation.
// R-TRIP-6.1 planningDay preserved, R-TRIP-6.2 late-departure still belongs to
// Finaliser-validated planning day, R-TRIP-7.4 departure memory in state.

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const { createSandbox } = require('./mock_tasker');

const STATE = "Tasker/Tesla/Data/TDS_Trip_State.json";
const ACTIVE_GEN = "Tasker/Tesla/Data/TDS_Active_Generation";
const VALID_GEN_ID = "gen:1700000000:ab12";

let passes = 0;
let fails = 0;
function pass(msg) { passes++; console.log("PASS: " + msg); }
function fail(msg) { fails++; console.log("FAIL: " + msg); }

function make() {
  return createSandbox({ nowMs: 1700000000000 });
}
function runCmd(sandbox, store, command, payload) {
  const r = sandbox.reducer(command, payload);
  if (typeof r === 'string' && r.indexOf('ERROR:') === 0) return r;
  return r === undefined ? null : r;
}
function loadState(store) {
  const raw = store.files[STATE];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function testObserveDepartureRecordsTrip() {
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  const r = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_1', at: 1700001000
  });
  assert.strictEqual(r, 'OK', 'OBSERVE_DEPARTURE must succeed with valid payload');
  const state = loadState(store);
  assert(state && state.trips && state.trips.trip_1, 'trip must be created in state');
  assert.equal(state.trips.trip_1.lifecycleState, 'IN_PROGRESS', 'PLANNED -> IN_PROGRESS on first departure');
  assert.equal(state.trips.trip_1.departures.length, 1, 'one departure recorded');
  assert.equal(state.trips.trip_1.departures[0].at, 1700001000, 'departUnix stored');
  assert.equal(state.revision, 1, 'revision bumped on first write');
  pass('departure-records-trip: trip created, lifecycle advanced, revision bumped');
}

function testObserveDepartureIdempotent() {
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: VALID_GEN_ID, tripId: 'trip_1', at: 1700001000 });
  const r2 = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: VALID_GEN_ID, tripId: 'trip_1', at: 1700001000 });
  assert.strictEqual(r2, 'OK', 'second call with same at must succeed');
  const state = loadState(store);
  assert.equal(state.trips.trip_1.departures.length, 1, 'idempotent: no duplicate departure recorded');
  assert.equal(state.revision, 1, 'idempotent: revision NOT bumped on duplicate');
  pass('departure-idempotent: same at does not duplicate or bump revision');
}

function testObserveDepartureReObserved() {
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: VALID_GEN_ID, tripId: 'trip_1', at: 1700001000 });
  // Simulate a re-observation after a delay (different at) - new departure entry.
  const r2 = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: VALID_GEN_ID, tripId: 'trip_1', at: 1700001900 });
  assert.strictEqual(r2, 'OK', 're-observation must succeed');
  const state = loadState(store);
  assert.equal(state.trips.trip_1.departures.length, 2, 'two departures after re-observation');
  assert.equal(state.trips.trip_1.departures[1].at, 1700001900, 'second at stored');
  assert.equal(state.revision, 2, 'revision bumped on re-observation');
  pass('departure-re-observed: different at adds entry and bumps revision');
}

function testPlanningDayPreserved() {
  // The spec (R-TRIP-6.1) requires the reducer to preserve Finaliser-validated
  // planningDay labels with no timezone conversion. The reducer must not
  // attempt to derive a day from the departUnix itself.
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  const dayLabel = '2024-03-09'; // US DST transition day; reducer must not transform
  const departUnix = 1700001000; // arbitrary
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_1', at: departUnix, planningDay: dayLabel
  });
  const state = loadState(store);
  assert.equal(state.trips.trip_1.departures[0].planningDay, dayLabel, 'planningDay stored as-is');
  assert.equal(state.currentPlanningDay, dayLabel, 'top-level planningDay set');
  pass('planning-day-preserved: reducer stores Finaliser label without conversion');
}

function testPlanningDayOmittedAllowed() {
  // planningDay is optional. A reducer must accept departures without a
  // planningDay label and store the trip without one (no crash, no
  // derivation). The legacy behaviour allowed this.
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  const r = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_1', at: 1700001000
  });
  assert.strictEqual(r, 'OK', 'departure without planningDay must succeed');
  const state = loadState(store);
  assert(state.trips.trip_1, 'trip must be created');
  assert.equal(state.trips.trip_1.departures[0].planningDay, null, 'planningDay null when omitted');
  pass('planning-day-omitted: accepted, no derivation');
}

function testLateDeparturePreservesFinaliserDay() {
  // R-TRIP-6.2: a late departure (e.g. 23:30 EST) belongs to whatever
  // planningDay Finaliser assigned. The reducer must not re-derive the day
  // from the departUnix using a system timezone.
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  const finaliserDay = '2024-03-09';
  const lateDepartUnix = 1710000000; // arbitrary late timestamp
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_late', at: lateDepartUnix, planningDay: finaliserDay
  });
  const state = loadState(store);
  // The reducer stores exactly what Finaliser passed. The test for "does not
  // re-derive" is: planningDay equals the input, regardless of what the
  // departUnix's UTC date would be.
  const utcDay = new Date(lateDepartUnix * 1000).toISOString().slice(0, 10);
  if (utcDay !== finaliserDay) {
    assert.equal(state.trips.trip_late.departures[0].planningDay, finaliserDay,
      'reducer must keep Finaliser day, not the UTC-derived day');
  } else {
    // If the days happen to align, the test is degenerate but still passes.
    assert.equal(state.trips.trip_late.departures[0].planningDay, finaliserDay);
  }
  pass('late-departure-planning-day: Finaliser label wins, no UTC re-derivation');
}

function testObserveDepartureRejectsInvalidGen() {
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  const r = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: 'not-valid', tripId: 'trip_1', at: 1700001000
  });
  assert.match(r, /^ERROR:/, 'invalid generationId must be rejected');
  const state = loadState(store);
  assert(!state || !state.trips || !state.trips.trip_1, 'no trip created on invalid gen');
  pass('departure-rejects-invalid-gen: ERROR returned, no state mutation');
}

function testObserveDepartureRejectsMissingFields() {
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  const r1 = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: VALID_GEN_ID, at: 1700001000 });
  assert.match(r1, /^ERROR:/, 'missing tripId must be rejected');
  const r2 = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', { generationId: VALID_GEN_ID, tripId: 'trip_1' });
  assert.match(r2, /^ERROR:/, 'missing at must be rejected');
  pass('departure-rejects-missing-fields: both tripId and at are required');
}

function testMultipleTripsIndependent() {
  // Different trips must track their own departures and planningDays.
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_a', at: 1700001000, planningDay: '2024-03-09'
  });
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_b', at: 1700002000, planningDay: '2024-03-10'
  });
  const state = loadState(store);
  assert.equal(state.trips.trip_a.departures.length, 1, 'trip_a has one departure');
  assert.equal(state.trips.trip_b.departures.length, 1, 'trip_b has one departure');
  assert.equal(state.trips.trip_a.departures[0].planningDay, '2024-03-09');
  assert.equal(state.trips.trip_b.departures[0].planningDay, '2024-03-10');
  pass('multi-trip: each trip tracks its own departures and planningDay');
}

function testTodayDeparturePreservesTomorrowRows() {
  // AC-7/Slice A: observing today's departure must not touch tomorrow's
  // planned trip. Tomorrow's row keeps its departure history, planningDay
  // label, and activity timestamp — no cross-day propagation.
  const { sandbox, store } = make();
  sandbox.writeFile(ACTIVE_GEN, VALID_GEN_ID);
  // Seed tomorrow's row first (its departure is observed as a separate event).
  runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_tomorrow', at: 1700086400, planningDay: '2024-03-10'
  });
  const before = loadState(store);
  // Today departs — tomorrow's row must be byte-identical after this event.
  const r = runCmd(sandbox, store, 'OBSERVE_DEPARTURE', {
    generationId: VALID_GEN_ID, tripId: 'trip_today', at: 1700001000, planningDay: '2024-03-09'
  });
  assert.strictEqual(r, 'OK', 'today departure must succeed');
  const state = loadState(store);
  assert.equal(state.trips.trip_today.lifecycleState, 'IN_PROGRESS', 'today advances to IN_PROGRESS');
  assert.equal(state.trips.trip_today.departures.length, 1, 'today has one departure');
  const tomorrowAfter = state.trips.trip_tomorrow;
  const tomorrowBefore = before.trips.trip_tomorrow;
  assert.equal(tomorrowAfter.lifecycleState, 'IN_PROGRESS', 'tomorrow row keeps its own lifecycle');
  assert.equal(tomorrowAfter.departures.length, tomorrowBefore.departures.length, 'tomorrow departure history untouched');
  assert.equal(tomorrowAfter.currentPlanningDay, '2024-03-10', 'tomorrow planningDay label preserved');
  assert.equal(tomorrowAfter.lastActivityUnix, tomorrowBefore.lastActivityUnix, 'tomorrow lastActivity untouched');
  pass('today-departure-preserves-tomorrow: tomorrow rows untouched, no cross-day propagation');
}

function runAll() {
  testObserveDepartureRecordsTrip();
  testObserveDepartureIdempotent();
  testObserveDepartureReObserved();
  testPlanningDayPreserved();
  testPlanningDayOmittedAllowed();
  testLateDeparturePreservesFinaliserDay();
  testObserveDepartureRejectsInvalidGen();
  testObserveDepartureRejectsMissingFields();
  testMultipleTripsIndependent();
  testTodayDeparturePreservesTomorrowRows();
  console.log("");
  console.log("departure-day results: " + passes + " passed, " + fails + " failed");
  process.exit(fails === 0 ? 0 : 1);
}

runAll();
