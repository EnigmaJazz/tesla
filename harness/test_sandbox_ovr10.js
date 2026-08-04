// OVR-10 (D1): Sandbox exact-key reads over schema-v2 stores.
//
// Seed TDS_Overrides.json and TDS_Routine_Preferences.json in schema-v2 shape
// (eventOverrides / seriesPreferences own-property maps) WITHOUT legacy CSV
// projections, then run Sandbox_Engine.js once. Three regressions:
//
//   1. Decoy occurrence IDs ev_1_kx8f00 / ev_10_kx8f00 — ev_1's skip:true is
//      honored by exact key while ev_10 remains a normal planned trip. Substring
//      membership would let the ev_10 row satisfy an ev_1 lookup.
//   2. seriesPreferences defaults are read by exact series/route keys — the
//      ev_10 and team_event_alpha routines apply, and the underscore core
//      team_event_alpha_kx8f00 parses at the FINAL underscore (coreId
//      team_event_alpha, not team).
//   3. The Sandbox never writes TDS_Overrides.json / TDS_Routine_Preferences.json
//      (single-writer contract — the Override Handler owns both).
//
// RED on master: the Sandbox reads legacy CSV projections only, so a pure
// schema-v2 seed leaves every override/preference invisible (ev_1 is enqueued
// and no routine notifications are emitted).

process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');

const nowSec = 1699988400; // 2023-11-14 19:00:00 UTC — three future events fit the same local day.
const homeCoords = "51.9,-2.1";
const ev1Coords = "52.0,-2.0";
const ev10Coords = "52.1,-2.2";
const teamCoords = "52.2,-2.3";

const EV1_ID = "ev_1_kx8f00";
const EV10_ID = "ev_10_kx8f00";
const TEAM_ID = "team_event_alpha_kx8f00";

// Events are spaced far enough that each leg's drive + attendance fits before
// the next start (otherwise the lateness halt clears the queue).
const masterJson = JSON.stringify([
  { id: EV1_ID, start: nowSec + 3600, end: nowSec + 6600, duration: 3000, title: "Decoy One", desc: "", loc: "A", coords: ev1Coords },
  { id: EV10_ID, start: nowSec + 9000, end: nowSec + 12000, duration: 3000, title: "Decoy Ten", desc: "", loc: "B", coords: ev10Coords },
  { id: TEAM_ID, start: nowSec + 14400, end: nowSec + 17400, duration: 3000, title: "Underscore Core", desc: "", loc: "C", coords: teamCoords }
]);

// Pure schema-v2 stores — no top-level CSV projections. The eventOverrides map
// carries only ev_1 (skip), so ev_10 must keep planning normally. The
// seriesPreferences map carries an ev_1 decoy entry on ev_10's route (IGNOREWALK)
// that must never leak into ev_10's lookups, plus the real ev_10 / team entries.
const ovrJson = JSON.stringify({
  schemaVersion: 2,
  eventOverrides: {
    [EV1_ID]: { mode: null, skip: true, trimmedEndUnix: null, pitstop: null, ignoreLateness: null, ignoreWalk: false }
  }
});

// The head event plans from the live base (homeCoords); each later event plans
// from the previous event's coords (Sandbox advances state.loc to the event).
const ev10RouteSig = homeCoords + "^" + ev10Coords;
const teamRouteSig = ev10Coords + "^" + teamCoords;

const prefsJson = JSON.stringify({
  schemaVersion: 2,
  seriesPreferences: {
    "ev_1": { [ev10RouteSig]: { defaults: { IGNOREWALK: true }, history: {} } },
    "ev_10": { [ev10RouteSig]: { defaults: { "IGNORELATENESS~fixed": true }, history: {} } },
    "team_event_alpha": { [teamRouteSig]: { defaults: { "IGNORELATENESS~fixed": true }, history: {} } }
  }
});

const baseGeocodes = [
  nowSec.toString(),
  (nowSec + 86400).toString(),
  homeCoords,
  "0",
  "Home",
  "",
  "home_base"
].join("~");

const files = {
  "Tasker/Tesla/Data/Itin_Master.json": "[]",
  "Tasker/Tesla/Data/TDS_Master.json": masterJson,
  "Tasker/Tesla/Data/TDS_Base_Geocodes.txt": baseGeocodes,
  "Tasker/Tesla/Data/TDS_Overrides.json": ovrJson,
  "Tasker/Tesla/Data/TDS_Routine_Preferences.json": prefsJson,
  "Tasker/Tesla/Data/Temp_Route_Cache.txt": "",
  "Tasker/Tesla/Data/RouteCache.txt": ""
};

const globals = {
  User_At_Base: "true",
  Base_Arrival_Unix: nowSec.toString(),
  User_Loc: homeCoords,
  Home_Coords: homeCoords,
  Current_Status: "",
  Arrival_Buffer_Mins: "5",
  Departure_Buffer_Mins: "5",
  Max_Walk_Meters: "8046",
  Daily_Walk_Meters: "0",
  Live_Traffic_Threshold: "7200",
  Car_Connected: "false"
};

const locals = {
  idx: "1",
  vcar_loc: homeCoords,
  virtual_time: String(nowSec),
  virtual_loc: homeCoords
};

function fail(msg) {
  console.log('FAIL: OVR-10 Sandbox — ' + msg);
  process.exit(1);
}

try {
  const { sandbox, store } = createSandbox({
    locals: locals,
    globals: globals,
    files: files,
    nowMs: nowSec * 1000
  });
  runScript(path.resolve(__dirname, '..', 'Sandbox_Engine.js'), sandbox, store);
  if (store.runError) fail('Sandbox threw: ' + store.runError.message + ' (line ' + store.runError.line + ')');

  // Single-writer contract: no OVR/PREFS writes from the Sandbox.
  const ovrPrefsWrites = store.writeLog.filter(function (w) {
    return w.path.indexOf('TDS_Overrides.json') !== -1 || w.path.indexOf('TDS_Routine_Preferences.json') !== -1;
  });
  if (ovrPrefsWrites.length !== 0) {
    fail('Sandbox must not write OVR/PREFS files (got ' + ovrPrefsWrites.length + ' writes)');
  }

  const queue = store.locals['block_queue'];
  if (!queue || queue === "EOF") fail('expected a non-empty block_queue');
  const rows = queue.split("~").filter(function (r) { return r; });

  function rowFor(eventId) {
    return rows.filter(function (r) { return r.split("|")[9] === eventId; });
  }

  // Exact-key skip: ev_1 (skip:true) must vanish; ev_10 and the underscore-core
  // event must stay planned. A substring membership read would let ev_10's row
  // satisfy the ev_1 lookup, so the decoy proves exact identity.
  const ev1Rows = rowFor(EV1_ID);
  if (ev1Rows.length !== 0) {
    fail('ev_1 skip override must remove its queue row (got ' + ev1Rows.length + ' rows)');
  }
  const ev10Rows = rowFor(EV10_ID);
  if (ev10Rows.length !== 1) {
    fail('ev_10 must remain planned by exact key (got ' + ev10Rows.length + ' rows)');
  }
  const teamRows = rowFor(TEAM_ID);
  if (teamRows.length !== 1) {
    fail('team_event_alpha_kx8f00 must remain planned (got ' + teamRows.length + ' rows)');
  }

  // Preference reads by exact series key + final-underscore core parsing.
  const notifs = (store.locals['notif_queue'] || "").split("^^").filter(function (n) { return n; });

  const ev10Notif = notifs.find(function (n) { return n.indexOf('|ev_10^') !== -1; });
  if (!ev10Notif) fail('ev_10 routine default should apply by exact series key');
  if (ev10Notif.indexOf('IGNORELATENESS~fixed') === -1) fail('ev_10 should receive its own lateness modifier');
  if (ev10Notif.indexOf('IGNOREWALK') !== -1) fail('ev_1 decoy modifier must not leak into ev_10 lookups');

  const teamNotif = notifs.find(function (n) { return n.indexOf('|team_event_alpha^') !== -1; });
  if (!teamNotif) fail('team_event_alpha routine default should apply');
  // The routine key uses the full underscore core, and the notification's final
  // field is the parsed coreId — split at the LAST underscore. split("_")[0]
  // would yield "team" and fail this check.
  if (teamNotif.slice(-17) !== '|team_event_alpha') {
    fail('occurrence parse must yield coreId team_event_alpha, got tail ' + JSON.stringify(teamNotif.slice(-20)));
  }

  console.log('PASS: OVR-10 Sandbox: exact-key override/preference reads; ev_1/ev_10 decoy isolated');
  console.log('  queue rows: ' + rows.length + ' (ev_1 skipped, ev_10 + team_event_alpha planned)');
  console.log('  notifications: ' + notifs.length + ' (ev_10 + team_event_alpha exact-key prefs applied)');
  console.log('  no OVR/PREFS writes from Sandbox');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
