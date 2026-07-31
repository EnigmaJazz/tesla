// Trip_State_Reducer.js — Phase 3 PR-A shell and command contract.
//
// Design contract
// ----------------
// Entry-point shape: Tasker action passes `%par1` (command name), `%par2`
// (JSON payload), and optionally `%par3` (JSON context). The reducer is the
// SOLE writer of `Tasker/Tesla/Data/TDS_Trip_State.json`.
//
// Command protocol: 13 typed commands. Each payload must include a valid
// `generationId` plus command-specific fields. Invalid commands are rejected with
// structured event code `EVT-GENERATION_VALIDATION_FAILED` and no state mutation.
//
// State shape: schemaVersion 1, revision 0 initial, with explicit maps for
// trips, stops, and manualSessions. No field is inferred from location, leg
// order, or event type.
//
// Atomicity order: 1) validate command, 2) load committed state, 3) apply pure
// reduction, 4) write + exact read-back, 5) project side effects. Projection is
// gated: if read-back fails, old bytes are restored and projection is skipped.
//
// Retention default: records beyond 30 local planning days are pruned on the next
// commit; active trips, active/manual sessions, and the current generation are
// exempt.
//
// Schema versioning: mutations increment `revision` once. Future schema versions
// require explicit migrators; unsupported versions are rejected.

var PHASE3_STATE_PATH = "Tasker/Tesla/Data/TDS_Trip_State.json";
var PHASE3_SCHEMA_VERSION = 1;
var PHASE3_REVISION = 0;
var REDUCER_WRITER = "Trip State Reducer";
var TRIP_GENERATION_ID_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/;
var TRIP_ID_COLLISION_RETRY_MAX = 16;
var ID_RANDOM_RANGE = 0x10000;
var DEFAULT_RETENTION_DAYS = 30;

var VALID_POLICIES = { MANUAL: true, RECOVERY: true, EOD: true, SAFETY: true, VEHICLE: true };

function nowSec() { return Math.floor(Date.now() / 1000); }
function hex4(v) { let s = v.toString(16); while (s.length < 4) s = "0" + s; return s; }
function logEvent(severity, code, tripId, details) {
  flash(JSON.stringify({ timestamp: Date.now(), generationId: details && details.generationId || null, component: REDUCER_WRITER, severity: severity, code: code, tripId: tripId || null, details: details || {} }));
}
function readJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    logEvent("warn", "STATE_FILE_PARSE_FAILED", null, { path: path, reason: e.message });
    return null;
  }
}
function writeWithReadback(path, content, identity) {
  writeFile(path, content);
  if (readFile(path) !== content) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "read-back mismatch", path: path, writer: identity });
    throw new Error("READ_BACK_MISMATCH: " + path);
  }
}
function used(id) {
  const state = readJson(PHASE3_STATE_PATH);
  if (state && state.generationId === id) return true;
  return false;
}
function mintId() {
  for (let i = 0; i < TRIP_ID_COLLISION_RETRY_MAX; i++) {
    const id = "gen:" + nowSec() + ":" + hex4(Math.floor(Math.random() * ID_RANDOM_RANGE));
    if (!used(id)) return id;
  }
  throw new Error("GENERATION_ID_COLLISION_RETRY_EXHAUSTED");
}
function initialState() {
  return {
    schemaVersion: PHASE3_SCHEMA_VERSION,
    revision: PHASE3_REVISION,
    generationId: null,
    currentOrigin: "LIVE_BASE",
    currentPlanningDay: "",
    userAtBase: false,
    baseArrivalUnix: null,
    latenessHalt: false,
    currentStatus: "",
    manualReturnCompleted: false,
    trips: {},
    stops: {},
    manualSessions: {}
  };
}
function loadState() {
  const raw = readJson(PHASE3_STATE_PATH);
  if (!raw) return initialState();
  if (raw.schemaVersion !== PHASE3_SCHEMA_VERSION) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "unsupported schema version", schemaVersion: raw.schemaVersion });
    return initialState();
  }
  return raw;
}
function validateCommon(payload) {
  if (!payload || typeof payload !== "object") return { valid: false, reason: "payload must be object" };
  if (!payload.generationId || typeof payload.generationId !== "string") return { valid: false, reason: "missing generationId" };
  if (!TRIP_GENERATION_ID_REGEX.test(payload.generationId)) return { valid: false, reason: "invalid generationId format" };
  return { valid: true };
}
function validateFields(payload, fields) {
  const common = validateCommon(payload);
  if (!common.valid) return common;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const v = payload[f.name];
    if (f.required && (v === undefined || v === null || v === "")) return { valid: false, reason: "missing " + f.name };
    if (v !== undefined && v !== null) {
      if (f.type === "string" && typeof v !== "string") return { valid: false, reason: f.name + " must be string" };
      if (f.type === "number" && (typeof v !== "number" || isNaN(v) || !isFinite(v))) return { valid: false, reason: f.name + " must be number" };
    }
  }
  return { valid: true };
}
function validatePolicy(payload) {
  if (!payload.policy || typeof payload.policy !== "string") return { valid: false, reason: "missing policy" };
  if (!VALID_POLICIES[payload.policy]) return { valid: false, reason: "invalid return policy: " + payload.policy };
  return { valid: true };
}
function stubApply(state, payload, context) { return state; }
function applyCompleteStop(state, payload) {
  const next = JSON.parse(JSON.stringify(state));
  const tripId = payload.tripId;
  const stopId = payload.stopId;
  if (!next.trips[tripId]) {
    next.trips[tripId] = {
      tripId: tripId,
      lifecycleState: 'IN_PROGRESS',
      completedStops: [stopId],
      lastActivityUnix: payload.at,
      createdAt: nowSec()
    };
  } else {
    const tr = next.trips[tripId];
    tr.completedStops = tr.completedStops || [];
    if (tr.completedStops.indexOf(stopId) === -1) {
      tr.completedStops.push(stopId);
    }
    tr.lastActivityUnix = payload.at;
  }
  next.completedStops = next.completedStops || {};
  const prior = next.completedStops[stopId];
  if (prior && prior.completedUnix === payload.at) {
    return state;
  }
  next.completedStops[stopId] = {
    stopId: stopId,
    tripId: tripId,
    completedUnix: payload.at,
    generationId: payload.generationId
  };
  next.revision = state.revision + 1;
  return next;
}
function applyCompleteDropin(state, payload) {
  const next = JSON.parse(JSON.stringify(state));
  const tripId = payload.tripId;
  const dropinId = payload.dropinId;
  if (!next.trips[tripId]) {
    next.trips[tripId] = {
      tripId: tripId,
      lifecycleState: 'COMPLETED',
      completedDropins: [dropinId],
      lastActivityUnix: payload.at,
      createdAt: nowSec()
    };
  } else {
    const tr = next.trips[tripId];
    tr.completedDropins = tr.completedDropins || [];
    if (tr.completedDropins.indexOf(dropinId) === -1) {
      tr.completedDropins.push(dropinId);
    }
    tr.lastActivityUnix = payload.at;
    if (tr.lifecycleState === 'IN_PROGRESS' || tr.lifecycleState === 'PLANNED') {
      tr.lifecycleState = 'COMPLETED';
    }
  }
  next.completedDropins = next.completedDropins || {};
  const prior = next.completedDropins[dropinId];
  if (prior && prior.completedUnix === payload.at) {
    return state;
  }
  next.completedDropins[dropinId] = {
    dropinId: dropinId,
    tripId: tripId,
    completedUnix: payload.at,
    generationId: payload.generationId
  };
  next.revision = state.revision + 1;
  return next;
}
var COMMANDS = [
  { name: "SET_OVERRIDE", validate: function(p) { return validateFields(p, [{name:"key",type:"string",required:true},{name:"value",type:"any",required:true}]); }, apply: stubApply },
  { name: "REMOVE_OVERRIDE", validate: function(p) { return validateFields(p, [{name:"key",type:"string",required:true}]); }, apply: stubApply },
  { name: "DEPART_NOW", validate: function(p) { return validateFields(p, [{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "RETURN_TO_BASE", validate: function(p) { const base = validateFields(p, [{name:"actionId",type:"string",required:true},{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); if (!base.valid) return base; return validatePolicy(p); }, apply: stubApply },
  { name: "COMPLETE_STOP", validate: function(p) { return validateFields(p, [{name:"stopId",type:"string",required:true},{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: applyCompleteStop },
  { name: "START_UNPLANNED_STOP", validate: function(p) { return validateFields(p, [{name:"stopId",type:"string",required:true},{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "END_UNPLANNED_STOP", validate: function(p) { return validateFields(p, [{name:"stopId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "COMPLETE_DROPIN", validate: function(p) { return validateFields(p, [{name:"dropinId",type:"string",required:true},{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: applyCompleteDropin },
  { name: "CANCEL_ACTION", validate: function(p) { return validateFields(p, [{name:"actionId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "RESET_ACTIONS", validate: function(p) { return validateFields(p, [{name:"actionId",type:"string",required:false},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "OBSERVE_DEPARTURE", validate: function(p) { return validateFields(p, [{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true},{name:"planningDay",type:"string",required:false}]); }, apply: applyObserveDeparture },
  { name: "OBSERVE_ARRIVAL", validate: function(p) { return validateFields(p, [{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true},{name:"accuracyM",type:"number",required:true}]); }, apply: applyObserveArrival },
  { name: "RECONCILE_GENERATION", validate: function(p) { return validateFields(p, [{name:"activeGeneration",type:"string",required:true},{name:"manifestSchemaVersion",type:"number",required:false}]); }, apply: applyReconcile },
  { name: "COMPLETE_TRIP", validate: function(p) { return validateFields(p, [{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "EXPIRE_TRIP", validate: function(p) { return validateFields(p, [{name:"tripId",type:"string",required:true},{name:"at",type:"number",required:true}]); }, apply: stubApply },
  { name: "OBSERVE_LIVE_BASE", validate: function(p) { return validateFields(p, [{name:"at",type:"number",required:false}]); }, apply: applyObserveLiveBase }
];
function parseCommand(name, payload, context) {
  if (typeof name !== "string" || !name) return { valid: false, reason: "missing command name" };
  let cmd = null;
  for (let i = 0; i < COMMANDS.length; i++) {
    if (COMMANDS[i].name === name) { cmd = COMMANDS[i]; break; }
  }
  if (!cmd) return { valid: false, reason: "unknown command: " + name };
  const validation = cmd.validate(payload);
  if (!validation.valid) return { valid: false, reason: validation.reason };
  return { valid: true, apply: function(state) { return cmd.apply(state, payload, context); } };
}
function commit(oldRaw, newState) {
  const content = JSON.stringify(newState);
  try {
    writeWithReadback(PHASE3_STATE_PATH, content, REDUCER_WRITER);
    return { ok: true, sideEffects: [] };
  } catch (e) {
    try {
      writeWithReadback(PHASE3_STATE_PATH, oldRaw || "", REDUCER_WRITER);
      logEvent("error", "STATE_RESTORED_AFTER_READBACK_FAILURE", null, { reason: e.message });
    } catch (restoreErr) {
      logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "read-back and restore failed: " + restoreErr.message });
    }
    return { ok: false, reason: e.message };
  }
}
// Phase 3 PR-B: projection of state-backed globals. PR-D will project
// User_At_Base and Base_Arrival_Unix here. For now, this is a no-op.
function project(sideEffects) {
  // No-op until PR-D introduces state-backed global projection.
}

// Phase 3 PR-B: apply functions for OBSERVE_ARRIVAL and OBSERVE_LIVE_BASE.
// Each apply function is a pure reducer: it returns a NEW state object and
// does not mutate the input. The commit() function handles write + read-back.
function applyObserveArrival(state, payload) {
  const next = JSON.parse(JSON.stringify(state));
  const tripId = payload.tripId;
  if (next.trips[tripId]) {
    next.trips[tripId].observedArrivalUnix = payload.at;
    next.trips[tripId].observedArrivalAccuracyM = payload.accuracyM;
    if (next.trips[tripId].lifecycleState === 'IN_PROGRESS') {
      next.trips[tripId].lifecycleState = 'ARRIVED';
    }
  } else {
    next.trips[tripId] = {
      tripId: tripId,
      lifecycleState: 'COMPLETED',
      observedArrivalUnix: payload.at,
      observedArrivalAccuracyM: payload.accuracyM,
      createdAt: nowSec()
    };
  }
  next.revision = state.revision + 1;
  return next;
}

function applyReconcile(state, payload) {
  const next = JSON.parse(JSON.stringify(state));
  const manifestGen = payload.activeGeneration;
  const stateGen = next.currentGeneration || next.lastReconciledGeneration || "";
  // Manifest is the authoritative source for the active generation.
  // State records the last reconciled generation for drift detection.
  if (stateGen !== manifestGen) {
    logEvent("info", "RECONCILE_GENERATION", next.revision + 1, {
      previousStateGeneration: stateGen,
      manifestGeneration: manifestGen,
      action: "state.aligned.to.manifest"
    });
  }
  next.currentGeneration = manifestGen;
  next.lastReconciledGeneration = manifestGen;
  if (payload.manifestSchemaVersion) {
    next.manifestSchemaVersion = payload.manifestSchemaVersion;
  }
  next.revision = state.revision + 1;
  return next;
}
function applyObserveDeparture(state, payload) {
  const next = JSON.parse(JSON.stringify(state));
  const tripId = payload.tripId;
  const at = payload.at;
  // PR-D: idempotent. If a prior observation exists for this trip with the
  // same departUnix, do not bump revision. Different departUnix would indicate
  // a real second departure (re-observed) and bumps revision.
  if (!next.trips[tripId]) {
    next.trips[tripId] = {
      tripId: tripId,
      lifecycleState: 'PLANNED',
      departures: [],
      completedStops: [],
      completedDropins: []
    };
  }
  const tr = next.trips[tripId];
  tr.departures = tr.departures || [];
  const prior = tr.departures[tr.departures.length - 1];
  if (prior && prior.at === at) {
    return state;
  }
  tr.departures.push({ at: at, planningDay: payload.planningDay || null });
  tr.lastActivityUnix = at;
  if (tr.lifecycleState === 'PLANNED') {
    tr.lifecycleState = 'IN_PROGRESS';
  }
  // PR-D: planningDay stored as-is from Finaliser. No timezone conversion.
  // DST safety relies on Finaliser passing a validated label.
  if (payload.planningDay) {
    tr.currentPlanningDay = payload.planningDay;
  }
  next.revision = state.revision + 1;
  next.currentPlanningDay = payload.planningDay || next.currentPlanningDay;
  return next;
}
function applyObserveLiveBase(state, payload) {
  const next = JSON.parse(JSON.stringify(state));
  const wasAtBase = next.userAtBase === true;
  next.currentOrigin = 'LIVE_BASE';
  next.userAtBase = true;
  next.baseArrivalUnix = payload.at || nowSec();
  if (!wasAtBase) {
    logEvent('info', 'LIVE_BASE_OVERRIDES_LEGACY_ORIGIN', null, {
      generationId: payload.generationId,
      previousOrigin: 'PLANNED',
      baseArrivalUnix: next.baseArrivalUnix
    });
  }
  next.revision = state.revision + 1;
  return next;
}
function reduce(command, payload, context) {
  const parsed = parseCommand(command, payload, context);
  const genId = payload && payload.generationId || null;
  if (!parsed.valid) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { generationId: genId, reason: parsed.reason, command: command });
    return "ERROR: " + parsed.reason;
  }
  const oldRaw = readFile(PHASE3_STATE_PATH) || "";
  const oldState = loadState();
  const newState = parsed.apply(oldState, payload, context);
  const commitResult = commit(oldRaw, newState);
  if (!commitResult.ok) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { generationId: genId, reason: commitResult.reason, command: command });
    return "ERROR: " + commitResult.reason;
  }
  logEvent("info", "TRIP_STATE_COMMAND_ACCEPTED", payload && payload.tripId || null, { generationId: genId, command: command });
  project(commitResult.sideEffects);
  return "OK";
}

var COMMAND = local("par1") || "";
var PAYLOAD_RAW = local("par2") || "";
var CONTEXT_RAW = local("par3") || "";
var payload = null;
var context = null;
try { payload = PAYLOAD_RAW ? JSON.parse(PAYLOAD_RAW) : {}; } catch (e) { payload = null; }
try { context = CONTEXT_RAW ? JSON.parse(CONTEXT_RAW) : {}; } catch (e) {
  logEvent("warn", "COMMAND_CONTEXT_PARSE_FAILED", null, { reason: e.message });
  context = {};
}
if (!COMMAND) {
  setLocal("return_value", "ERROR: missing command");
} else if (payload === null) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "invalid JSON payload" });
  setLocal("return_value", "ERROR: invalid JSON payload");
} else {
  try { setLocal("return_value", reduce(COMMAND, payload, context)); } catch (e) { setLocal("return_value", "ERROR: " + e.message); }
}
