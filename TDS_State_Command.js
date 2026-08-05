// TDS_State_Command.js — Phase 4 Slice A serial command router.
//
// Input is %par1 (exact command name) plus %par2 (JSON object payload).
// parseEnvelope validates the command against an exact table and validates
// fields/types/IDs BEFORE any mutation; routeCommand sets tds_state_owner,
// routes to exactly one declared owner, and passes the owner result through
// return_value (OK.../ERROR: ...). In the harness the owner shims
// (reducer()/handler()/publish()) run synchronously; in the serial Tasker
// task the staged owner runs next. ENQUEUE_REORDER is owned in-file: this
// script solely appends TDS_Reorder_Commands.json, and the Generation
// Publisher is the sole drainer.
//
// Phase 4 Slice B: the Manual Action Handler lives in-file and is the sole
// writer of TDS_Action_Sessions.json and TDS_Manual_Trips.json (RULE-8D).
// RETURN_TO_BASE routes to the reducer, which stages SESSION_OPEN; the
// handler then commits both records with snapshots, read-back, and exact
// rollback. RELEASE closes the exact actionId/tripId pair and may clear the
// matching migration-only TDS_Action_Lock.json (LOCK_COMPATIBILITY_CLEARED).

const REORDER_QUEUE_PATH = "Tasker/Tesla/Data/TDS_Reorder_Commands.json";
const MANUAL_SESSIONS_PATH = "Tasker/Tesla/Data/TDS_Action_Sessions.json";
const MANUAL_TRIPS_PATH = "Tasker/Tesla/Data/TDS_Manual_Trips.json";
const MANUAL_LOCK_PATH = "Tasker/Tesla/Data/TDS_Action_Lock.json";
// Names are unique at the top level (const/let re-declaration is a SyntaxError
// in the shared harness vm context; entry identifiers use var like the owners).
var STATE_CMD_REORDER_TYPE = "APPLY_CLUSTER_REORDER";
var STATE_CMD_GEN_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/;
var STATE_CMD_ID_SUFFIX_MIN = 1e9;
var STATE_CMD_ID_SUFFIX_MAX = 2.5e9;
var STATE_CMD_ID_REGEX = /^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$/;
var HANDLER_WRITER = "Manual Action Handler";
var HANDLER_SCHEMA_VERSION = 1;
var HANDLER_EXPIRY_SECS = 4 * 3600;
var HANDLER_ID_RETRY_MAX = 16;
var HANDLER_SCOPES = ["PRESERVE_ACTIVE_TRIP", "SUPPRESS_REPLAN_REPLACEMENT"];
const COMPONENT = "TDS_State_Command";

// Exact command table — every command maps to exactly one declared owner.
const REDUCER_COMMANDS = ["SET_OVERRIDE", "REMOVE_OVERRIDE", "DEPART_NOW", "RETURN_TO_BASE", "COMPLETE_STOP",
  "START_UNPLANNED_STOP", "END_UNPLANNED_STOP", "COMPLETE_DROPIN", "CANCEL_ACTION", "RESET_ACTIONS",
  "OBSERVE_DEPARTURE", "OBSERVE_ARRIVAL", "RECONCILE_GENERATION", "COMPLETE_TRIP", "EXPIRE_TRIP", "OBSERVE_LIVE_BASE"];
const OVERRIDE_COMMANDS = ["APPLY_OVERRIDE", "APPEND_OVERRIDE", "SET_DEFAULT", "PRUNE"];
const MANUAL_COMMANDS = ["SESSION_OPEN", "SESSION_CLOSE", "RELEASE", "ENQUEUE_REORDER"];
const PUBLISHER_COMMANDS = ["PUBLISH_GENERATION"];
const OWNER = {};
REDUCER_COMMANDS.forEach(function (c) { OWNER[c] = "Trip_State_Reducer"; });
OVERRIDE_COMMANDS.forEach(function (c) { OWNER[c] = "Override_Handler"; });
MANUAL_COMMANDS.forEach(function (c) { OWNER[c] = "Manual_Action_Handler"; });
PUBLISHER_COMMANDS.forEach(function (c) { OWNER[c] = "Generation_Publisher"; });

// Minimal pre-invocation field/type contract (REQ-4CMD-1): the router
// mirrors Trip_State_Reducer.COMMANDS validateFields entries (types,
// required/optional, "any") plus validateCommon generationId, so a bad
// payload can never reach an owner. Owner-level semantic validation (e.g.
// RETURN_TO_BASE policy, trip existence) stays with the owner.
const REDUCER_REQUIRED_FIELDS = {
  SET_OVERRIDE: [{ name: "key", type: "string", required: true }, { name: "value", type: "any", required: true }],
  REMOVE_OVERRIDE: [{ name: "key", type: "string", required: true }],
  DEPART_NOW: [{ name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  RETURN_TO_BASE: [{ name: "actionId", type: "string", required: true }, { name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  COMPLETE_STOP: [{ name: "stopId", type: "string", required: true }, { name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  START_UNPLANNED_STOP: [{ name: "stopId", type: "string", required: true }, { name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  END_UNPLANNED_STOP: [{ name: "stopId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  COMPLETE_DROPIN: [{ name: "dropinId", type: "string", required: true }, { name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  CANCEL_ACTION: [{ name: "actionId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  RESET_ACTIONS: [{ name: "actionId", type: "string", required: false }, { name: "at", type: "number", required: true }],
  OBSERVE_DEPARTURE: [{ name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }, { name: "planningDay", type: "string", required: false }],
  OBSERVE_ARRIVAL: [{ name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }, { name: "accuracyM", type: "number", required: true }],
  RECONCILE_GENERATION: [{ name: "activeGeneration", type: "string", required: true }, { name: "manifestSchemaVersion", type: "number", required: false }],
  COMPLETE_TRIP: [{ name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }, { name: "planningDay", type: "string", required: false }],
  EXPIRE_TRIP: [{ name: "tripId", type: "string", required: true }, { name: "at", type: "number", required: true }],
  OBSERVE_LIVE_BASE: [{ name: "at", type: "number", required: false }]
};

// Trusted reorder producers (REQ-4REORDER-2): a legacy-null generationId is
// permitted only from a known producer; unknown/empty sources are rejected.
const STATE_CMD_TRUSTED_SOURCES = { "Gatekeeper": true, "API_Parser": true };

// Manual commands are owned by the in-file Manual Action Handler (Slice B).

function nowSec() { return Math.floor(Date.now() / 1000); }
function stateCmdLogEvent(severity, code, details) {
  flash(JSON.stringify({ timestamp: Date.now(), generationId: global('TDS_Active_Generation') || null,
    component: COMPONENT, severity: severity, code: code, tripId: details && details.tripId || null, details: details || {} }));
}
function readJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === "string" && v.length > 0; }
// [ID-2] Strict occurrence-ID check: <coreId>_<base36StartUnix> via lastIndexOf.
function parseOccurrenceId(rawId) {
  if (!isNonEmptyString(rawId)) return { ok: false, reason: "empty_id" };
  const lastSep = rawId.lastIndexOf("_");
  if (lastSep <= 0 || lastSep === rawId.length - 1) return { ok: false, reason: "malformed_format" };
  const match = STATE_CMD_ID_REGEX.exec(rawId);
  if (!match) return { ok: false, reason: "malformed_format" };
  const suffixNum = parseInt(match[2], 36);
  if (isNaN(suffixNum) || suffixNum < STATE_CMD_ID_SUFFIX_MIN || suffixNum >= STATE_CMD_ID_SUFFIX_MAX) return { ok: false, reason: "invalid_suffix" };
  return { ok: true, rawId: rawId };
}
function validGenerationId(v) { return v === null || (typeof v === "string" && STATE_CMD_GEN_REGEX.test(v)); }

// Field/type/ID validation the router guarantees before routing; owner-level
// payload validation stays with the owner.
function validateCommand(command, payload) {
  if (!Object.prototype.hasOwnProperty.call(OWNER, command)) return "unknown command: " + command;
  if (!isObject(payload)) return "payload must be a JSON object";
  if (command === "ENQUEUE_REORDER") {
    if (!validGenerationId(payload.generationId)) return "invalid generationId";
    if (!isNonEmptyString(payload.clusterId)) return "clusterId must be a non-empty string";
    if (!Array.isArray(payload.orderedEventIds) || payload.orderedEventIds.length === 0) return "orderedEventIds must be a non-empty array";
    for (let i = 0; i < payload.orderedEventIds.length; i++) {
      if (!isNonEmptyString(payload.orderedEventIds[i])) return "orderedEventIds entries must be non-empty strings";
    }
    if (!isNonEmptyString(payload.source)) return "source must be a non-empty string";
    if (payload.emittedAt !== undefined && typeof payload.emittedAt !== "number") return "emittedAt must be a number";
  } else if (command === "APPEND_OVERRIDE") {
    if (!parseOccurrenceId(payload.baseId).ok) return "invalid occurrence id";
    if (!isNonEmptyString(payload.targetArray)) return "targetArray must be a non-empty string";
  } else if (command === "APPLY_OVERRIDE") {
    if (!parseOccurrenceId(payload.targetId).ok) return "invalid occurrence id";
    if (!isNonEmptyString(payload.overrideKey)) return "overrideKey must be a non-empty string";
  } else if (command === "PUBLISH_GENERATION") {
    if (!Array.isArray(payload.events) || !Array.isArray(payload.master) || !Array.isArray(payload.itinerary)) {
      return "publish candidate must carry events/master/itinerary arrays";
    }
  } else if (command === "SESSION_OPEN") {
    if (!isNonEmptyString(payload.type)) return "type must be a non-empty string";
    if (typeof payload.at !== "number" || isNaN(payload.at) || !isFinite(payload.at)) return "at must be a number";
    if (payload.scopes !== undefined && (!Array.isArray(payload.scopes) || payload.scopes.some(function (s) { return !isNonEmptyString(s); }))) {
      return "scopes must be an array of non-empty strings";
    }
  } else if (command === "SESSION_CLOSE") {
    if (!isNonEmptyString(payload.actionId)) return "actionId must be a non-empty string";
    if (payload.at !== undefined && (typeof payload.at !== "number" || isNaN(payload.at) || !isFinite(payload.at))) return "at must be a number";
  } else if (command === "RELEASE") {
    if (!isNonEmptyString(payload.actionId)) return "actionId must be a non-empty string";
    if (!isNonEmptyString(payload.tripId)) return "tripId must be a non-empty string";
    if (payload.at !== undefined && (typeof payload.at !== "number" || isNaN(payload.at) || !isFinite(payload.at))) return "at must be a number";
  } else if (REDUCER_REQUIRED_FIELDS[command]) {
    // Mirror the reducer's validateCommon + validateFields contract so a
    // bad payload can never reach an owner (REQ-4CMD-1).
    if (!payload.generationId || typeof payload.generationId !== "string") {
      return "missing generationId";
    }
    if (!STATE_CMD_GEN_REGEX.test(payload.generationId)) {
      return "invalid generationId format";
    }
    const fields = REDUCER_REQUIRED_FIELDS[command];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const v = payload[f.name];
      if (f.required && (v === undefined || v === null || v === "")) {
        return "missing " + f.name;
      }
      if (v !== undefined && v !== null) {
        if (f.type === "string" && typeof v !== "string") return f.name + " must be string";
        if (f.type === "number" && (typeof v !== "number" || isNaN(v) || !isFinite(v))) return f.name + " must be number";
      }
    }
  }
  return null;
}

// State Command owns the queue append; the Generation Publisher drains it.
function enqueueReorder(payload) {
  const queue = readJson(REORDER_QUEUE_PATH);
  const commands = Array.isArray(queue) ? queue : [];
  commands.push({
    type: STATE_CMD_REORDER_TYPE,
    generationId: payload.generationId === undefined ? null : payload.generationId,
    clusterId: payload.clusterId,
    orderedEventIds: payload.orderedEventIds,
    source: payload.source,
    emittedAt: typeof payload.emittedAt === "number" ? payload.emittedAt : nowSec()
  });
  writeFile(REORDER_QUEUE_PATH, JSON.stringify(commands));
  stateCmdLogEvent("info", "REORDER_COMMAND_ENQUEUED", { command: "ENQUEUE_REORDER", clusterId: payload.clusterId, count: commands.length });
  return "OK: ENQUEUE_REORDER " + payload.clusterId;
}

// --- Manual Action Handler (Slice B) ------------------------------------
// Sole writer of TDS_Action_Sessions.json / TDS_Manual_Trips.json (RULE-8D).
// Commands: SESSION_OPEN (commit both records with snapshot/read-back/
// rollback), SESSION_CLOSE (close only that session), RELEASE (close the exact
// actionId/tripId pair and optionally clear the matching legacy lock).

function readSessionsFile() {
  const obj = readJson(MANUAL_SESSIONS_PATH);
  if (obj && obj.schemaVersion === HANDLER_SCHEMA_VERSION && obj.sessions) return obj;
  return { schemaVersion: HANDLER_SCHEMA_VERSION, sessions: {} };
}
function readManualTripsFile() {
  const obj = readJson(MANUAL_TRIPS_PATH);
  if (obj && obj.schemaVersion === HANDLER_SCHEMA_VERSION && obj.trips) return obj;
  return { schemaVersion: HANDLER_SCHEMA_VERSION, trips: {} };
}
function writeWithReadback(path, content) {
  writeFile(path, content);
  if (readFile(path) !== content) {
    stateCmdLogEvent("error", "GENERATION_VALIDATION_FAILED", { reason: "read-back mismatch", path: path, writer: HANDLER_WRITER });
    throw new Error("READ_BACK_MISMATCH: " + path);
  }
}
function snapshotFile(path) {
  // Faithful existence snapshot: a present empty file (raw "") must be
  // restored as present-empty, never deleted as if absent. readFile returns
  // null ONLY for a missing file (Tasker-faithful mock + runtime).
  const raw = readFile(path);
  return { existed: raw !== null, raw: raw === null ? "" : raw };
}
function restoreSnapshot(path, snap) {
  try {
    if (snap.existed) {
      writeFile(path, snap.raw);
      if (readFile(path) !== snap.raw) {
        stateCmdLogEvent("error", "GENERATION_VALIDATION_FAILED", { reason: "snapshot restore read-back mismatch: " + path });
      }
    } else {
      deleteFile(path);
    }
  } catch (e) {
    stateCmdLogEvent("error", "GENERATION_VALIDATION_FAILED", { reason: "snapshot restore failed: " + path + ": " + e.message });
  }
}
// Collision-safe manual ids: <core>_<base36Unix> via the lastIndexOf("_") and
// base-36 suffix convention (ID-2). Bounded retry re-encodes a later second
// when the candidate already exists. Callers may provide IDs (e.g. the
// adapter) or omit them to let the handler mint; in BOTH cases the handler
// re-mints on collision so a same-second duplicate cannot fail.
function mintManualId(prefix, existing) {
  const base = nowSec();
  for (let i = 0; i < HANDLER_ID_RETRY_MAX; i++) {
    const id = prefix + "_" + (base + i).toString(36);
    if (!existing || !existing[id]) return id;
  }
  throw new Error("MANUAL_ID_COLLISION_RETRY_EXHAUSTED");
}
// Single-point id authority (REQ-4SESSION-1): the router re-mints colliding
// manual ids against the CURRENT sessions/manual-trips files BEFORE routing,
// so the reducer trip and the staged SESSION_OPEN always share identical ids.
// The handler's openSession re-mint remains as a pure safety net.
function ensureUniqueManualIds(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const sessions = readSessionsFile();
  const trips = readManualTripsFile();
  if (payload.actionId && sessions.sessions[payload.actionId]) {
    payload.actionId = mintManualId("action", sessions.sessions);
  }
  if (payload.tripId && trips.trips[payload.tripId]) {
    payload.tripId = mintManualId("manual_return", trips.trips);
  }
  return payload;
}
function openSession(payload) {
  const sessions = readSessionsFile();
  const trips = readManualTripsFile();
  let actionId = payload.actionId || mintManualId("action", sessions.sessions);
  let tripId = payload.tripId || mintManualId("manual_return", trips.trips);
  // Even when the caller supplied IDs, they must be unique in the current
  // files: re-mint (bounded retry) instead of throwing on a same-second
  // duplicate (REQ-4SESSION-1 collision safety).
  if (sessions.sessions[actionId]) actionId = mintManualId("action", sessions.sessions);
  if (trips.trips[tripId]) tripId = mintManualId("manual_return", trips.trips);
  const at = payload.at;
  const expiry = at + HANDLER_EXPIRY_SECS;
  const trip = {
    tripId: tripId, actionId: actionId, legType: "MANUAL_RETURN", lifecycleState: "IN_PROGRESS",
    departurePolicy: "ASAP", originSource: "ACTIVE_MANUAL_TRIP", planningDay: payload.planningDay || null,
    originCoords: payload.originCoords || "", targetCoords: payload.targetCoords || "",
    targetTitle: payload.targetTitle || "Return to Base", mode: payload.mode || "DRIVE",
    actualDepartUnix: 0, estimatedArrivalUnix: at + payload.durationSecs,
    relevanceDeadlineUnix: expiry, durationSecs: payload.durationSecs,
    distanceMiles: payload.distanceMiles || 0, createdAt: at
  };
  const session = {
    actionId: actionId, type: payload.type || "MANUAL_RETURN", tripId: tripId,
    createdAt: at, expiresAt: expiry, status: "ACTIVE",
    scopes: Array.isArray(payload.scopes) && payload.scopes.length > 0 ? payload.scopes : HANDLER_SCOPES.slice(),
    closedAt: null, closeReason: null
  };
  const tripsSnap = snapshotFile(MANUAL_TRIPS_PATH);
  const sessionsSnap = snapshotFile(MANUAL_SESSIONS_PATH);
  const newTrips = { schemaVersion: HANDLER_SCHEMA_VERSION, trips: Object.assign({}, trips.trips) };
  newTrips.trips[tripId] = trip;
  const newSessions = { schemaVersion: HANDLER_SCHEMA_VERSION, sessions: Object.assign({}, sessions.sessions) };
  newSessions.sessions[actionId] = session;
  try {
    writeWithReadback(MANUAL_TRIPS_PATH, JSON.stringify(newTrips));       // first file
    writeWithReadback(MANUAL_SESSIONS_PATH, JSON.stringify(newSessions)); // second file
  } catch (e) {
    restoreSnapshot(MANUAL_SESSIONS_PATH, sessionsSnap);
    restoreSnapshot(MANUAL_TRIPS_PATH, tripsSnap);
    throw new Error("SESSION_COMMIT_FAILED: " + e.message);
  }
  stateCmdLogEvent("info", "SESSION_OPENED", { actionId: actionId, tripId: tripId, type: session.type, expiresAt: expiry });
  return "OK: SESSION_OPEN " + actionId;
}
function closeSession(payload) {
  const sessions = readSessionsFile();
  const actionId = payload.actionId;
  const session = sessions.sessions[actionId];
  if (!session) throw new Error("SESSION_NOT_FOUND: " + actionId);
  if (session.status === "ACTIVE") {
    session.status = "CLOSED";
    session.closedAt = payload.at || nowSec();
    session.closeReason = payload.reason || "CLOSED";
    writeWithReadback(MANUAL_SESSIONS_PATH, JSON.stringify(sessions));
  }
  stateCmdLogEvent("info", "SESSION_CLOSED", { actionId: actionId, tripId: session.tripId, status: session.status });
  return "OK: SESSION_CLOSE " + actionId;
}
function releaseSession(payload) {
  const actionId = payload.actionId;
  const tripId = payload.tripId;
  const at = payload.at || nowSec();
  const sessions = readSessionsFile();
  const trips = readManualTripsFile();
  const session = sessions.sessions[actionId];
  if (!session || session.tripId !== tripId) throw new Error("RELEASE_MISMATCH: " + actionId + "/" + tripId);
  const tripsSnap = snapshotFile(MANUAL_TRIPS_PATH);
  const sessionsSnap = snapshotFile(MANUAL_SESSIONS_PATH);
  const newTrips = { schemaVersion: HANDLER_SCHEMA_VERSION, trips: Object.assign({}, trips.trips) };
  const newSessions = { schemaVersion: HANDLER_SCHEMA_VERSION, sessions: Object.assign({}, sessions.sessions) };
  if (newSessions.sessions[actionId].status === "ACTIVE") {
    newSessions.sessions[actionId].status = "CLOSED";
    newSessions.sessions[actionId].closedAt = at;
    newSessions.sessions[actionId].closeReason = "COMPLETED";
  }
  if (newTrips.trips[tripId] && newTrips.trips[tripId].lifecycleState !== "COMPLETED") {
    newTrips.trips[tripId].lifecycleState = "COMPLETED";
    newTrips.trips[tripId].completedAt = at;
  }
  try {
    writeWithReadback(MANUAL_TRIPS_PATH, JSON.stringify(newTrips));
    writeWithReadback(MANUAL_SESSIONS_PATH, JSON.stringify(newSessions));
  } catch (e) {
    restoreSnapshot(MANUAL_SESSIONS_PATH, sessionsSnap);
    restoreSnapshot(MANUAL_TRIPS_PATH, tripsSnap);
    throw new Error("RELEASE_COMMIT_FAILED: " + e.message);
  }
  // Migration-only lock (REQ-4SESSION-2): the handler may clear a matching
  // legacy lock; the lock is never authoritative and never recreated.
  const lockRaw = readFile(MANUAL_LOCK_PATH);
  if (lockRaw && lockRaw !== "{}") {
    let lock = null;
    try { lock = JSON.parse(lockRaw); } catch (e) { lock = null; }
    if (lock && (lock.actionId === actionId || lock.eventId === tripId || lock.tripId === tripId)) {
      // REQ-4SESSION-2: the compatibility clear must match the release
      // exactly. If the lock carries ANY present identifier that CONFLICTS
      // with this action/trip, it is a different lock — do not clear it.
      const actionMatch = lock.actionId === undefined || lock.actionId === null || lock.actionId === actionId;
      const eventMatch = lock.eventId === undefined || lock.eventId === null || lock.eventId === tripId;
      const tripMatch = lock.tripId === undefined || lock.tripId === null || lock.tripId === tripId;
      if (actionMatch && eventMatch && tripMatch) {
        writeWithReadback(MANUAL_LOCK_PATH, "{}");
        stateCmdLogEvent("info", "LOCK_COMPATIBILITY_CLEARED", { actionId: actionId, tripId: tripId });
      }
    }
  }
  stateCmdLogEvent("info", "SESSION_CLOSED", { actionId: actionId, tripId: tripId, closeReason: "COMPLETED" });
  return "OK: RELEASE " + actionId;
}
function manualAction(command, payload) {
  if (command === "SESSION_OPEN") return openSession(payload);
  if (command === "SESSION_CLOSE") return closeSession(payload);
  if (command === "RELEASE") return releaseSession(payload);
  throw new Error("unknown manual command: " + command);
}

// Routes one envelope: validates, sets the owner, then dispatches to the owner
// shim (harness) or re-stages for the serial Tasker task.
function routeCommand(command, payload) {
  const rejectReason = validateCommand(command, payload);
  if (rejectReason) {
    setLocal('tds_state_owner', '');
    stateCmdLogEvent("warn", "STATE_COMMAND_REJECTED", { command: command, reason: rejectReason });
    setLocal('return_value', "ERROR: " + rejectReason);
    return;
  }
  const owner = OWNER[command];
  setLocal('tds_state_owner', owner);
  stateCmdLogEvent("info", "STATE_COMMAND_ROUTED", { command: command, owner: owner, tripId: payload.tripId || null });
  try {
    // Single-point id authority: re-mint colliding manual ids BEFORE the
    // reducer commits, so reducer state and the staged SESSION_OPEN agree.
    if (command === "RETURN_TO_BASE" || command === "SESSION_OPEN") {
      ensureUniqueManualIds(payload);
    }
    if (command === "ENQUEUE_REORDER") {
      setLocal('return_value', enqueueReorder(payload));
    } else if (owner === "Trip_State_Reducer") {
      setLocal('return_value', typeof reducer === "function" ? reducer(command, payload) : "OK");
      // Slice B (REQ-4ADAPTER-4): RETURN_TO_BASE stages SESSION_OPEN for the
      // Manual Action Handler; run the staged owner now (serial task parity).
      if (command === "RETURN_TO_BASE" && local('par1') === "SESSION_OPEN") {
        let staged = null;
        try { staged = local('par2') ? JSON.parse(local('par2')) : null; } catch (e) { staged = null; }
        if (!staged) {
          stateCmdLogEvent("warn", "STATE_COMMAND_REJECTED", { command: "SESSION_OPEN", reason: "invalid staged payload" });
          setLocal('return_value', "ERROR: invalid staged SESSION_OPEN payload");
        } else {
          try {
            setLocal('return_value', manualAction("SESSION_OPEN", staged));
          } catch (e) {
            stateCmdLogEvent("warn", "STATE_COMMAND_REJECTED", { command: "SESSION_OPEN", reason: e.message });
            setLocal('return_value', "ERROR: " + e.message);
          }
        }
      }
    } else if (owner === "Override_Handler") {
      setLocal('return_value', typeof handler === "function" ? handler(command, payload) : "OK");
    } else if (owner === "Manual_Action_Handler") {
      setLocal('return_value', manualAction(command, payload));
    } else if (owner === "Generation_Publisher") {
      if (typeof publish === "function") {
        setLocal('return_value', String(publish(payload)));
      } else {
        setLocal('par1', JSON.stringify(payload)); // publisher reads the candidate from par1
        setLocal('return_value', "OK");
      }
    }
  } catch (e) {
    stateCmdLogEvent("warn", "STATE_COMMAND_REJECTED", { command: command, reason: e.message });
    setLocal('return_value', "ERROR: " + e.message);
  }
}

var COMMAND = local("par1") || "";
var PAYLOAD_RAW = local("par2") || "";
var payload = null;
try { payload = PAYLOAD_RAW ? JSON.parse(PAYLOAD_RAW) : null; } catch (e) { payload = null; }
if (!COMMAND) {
  stateCmdLogEvent("warn", "STATE_COMMAND_REJECTED", { command: "", reason: "missing command" });
  setLocal('return_value', "ERROR: missing command");
} else if (payload === null) {
  setLocal('tds_state_owner', '');
  stateCmdLogEvent("warn", "STATE_COMMAND_REJECTED", { command: COMMAND, reason: "invalid JSON payload" });
  setLocal('return_value', "ERROR: invalid JSON payload");
} else {
  routeCommand(COMMAND, payload);
}
