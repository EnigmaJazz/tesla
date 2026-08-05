// TDS_State_Command.js — Phase 4 Slice A serial command router.
//
// Input is %par1 (exact command name) plus %par2 (JSON object payload).
// parseEnvelope validates the command against an exact table and validates
// fields/types/IDs BEFORE any mutation; routeCommand sets tds_state_owner,
// routes to exactly one declared owner, and passes the owner result through
// return_value (OK.../ERROR: ...). In the harness the owner shims
// (reducer()/handler()/publish()) run synchronously; in the serial Tasker
// task the staged owner runs next. ENQUEUE_REORDER is owned in-file (Manual
// Action Handler stub for Slice A): this script solely appends
// TDS_Reorder_Commands.json, and the Generation Publisher is the sole drainer.

const REORDER_QUEUE_PATH = "Tasker/Tesla/Data/TDS_Reorder_Commands.json";
// Names are unique at the top level (const/let re-declaration is a SyntaxError
// in the shared harness vm context; entry identifiers use var like the owners).
var STATE_CMD_REORDER_TYPE = "APPLY_CLUSTER_REORDER";
var STATE_CMD_GEN_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/;
var STATE_CMD_ID_SUFFIX_MIN = 1e9;
var STATE_CMD_ID_SUFFIX_MAX = 2.5e9;
var STATE_CMD_ID_REGEX = /^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$/;
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

// Manual commands whose real handler lands in Slice B; rejected in Slice A.
const MANUAL_PENDING = { SESSION_OPEN: true, SESSION_CLOSE: true, RELEASE: true };

function nowSec() { return Math.floor(Date.now() / 1000); }
function logEvent(severity, code, details) {
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
  if (MANUAL_PENDING[command]) return command + " pending Manual Action Handler (Slice B)";
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
  } else if (command === "RECONCILE_GENERATION") {
    if (!isNonEmptyString(payload.activeGeneration)) return "activeGeneration must be a string";
  } else if (command === "PUBLISH_GENERATION") {
    if (!Array.isArray(payload.events) || !Array.isArray(payload.master) || !Array.isArray(payload.itinerary)) {
      return "publish candidate must carry events/master/itinerary arrays";
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
  logEvent("info", "REORDER_COMMAND_ENQUEUED", { command: "ENQUEUE_REORDER", clusterId: payload.clusterId, count: commands.length });
  return "OK: ENQUEUE_REORDER " + payload.clusterId;
}

// Routes one envelope: validates, sets the owner, then dispatches to the owner
// shim (harness) or re-stages for the serial Tasker task.
function routeCommand(command, payload) {
  const rejectReason = validateCommand(command, payload);
  if (rejectReason) {
    setLocal('tds_state_owner', '');
    logEvent("warn", "STATE_COMMAND_REJECTED", { command: command, reason: rejectReason });
    setLocal('return_value', "ERROR: " + rejectReason);
    return;
  }
  const owner = OWNER[command];
  setLocal('tds_state_owner', owner);
  logEvent("info", "STATE_COMMAND_ROUTED", { command: command, owner: owner, tripId: payload.tripId || null });
  try {
    if (command === "ENQUEUE_REORDER") {
      setLocal('return_value', enqueueReorder(payload));
    } else if (owner === "Trip_State_Reducer") {
      setLocal('return_value', typeof reducer === "function" ? reducer(command, payload) : "OK");
    } else if (owner === "Override_Handler") {
      setLocal('return_value', typeof handler === "function" ? handler(command, payload) : "OK");
    } else if (owner === "Generation_Publisher") {
      if (typeof publish === "function") {
        setLocal('return_value', String(publish(payload)));
      } else {
        setLocal('par1', JSON.stringify(payload)); // publisher reads the candidate from par1
        setLocal('return_value', "OK");
      }
    }
  } catch (e) {
    logEvent("warn", "STATE_COMMAND_REJECTED", { command: command, reason: e.message });
    setLocal('return_value', "ERROR: " + e.message);
  }
}

var COMMAND = local("par1") || "";
var PAYLOAD_RAW = local("par2") || "";
var payload = null;
try { payload = PAYLOAD_RAW ? JSON.parse(PAYLOAD_RAW) : null; } catch (e) { payload = null; }
if (!COMMAND) {
  logEvent("warn", "STATE_COMMAND_REJECTED", { command: "", reason: "missing command" });
  setLocal('return_value', "ERROR: missing command");
} else if (payload === null) {
  setLocal('tds_state_owner', '');
  logEvent("warn", "STATE_COMMAND_REJECTED", { command: COMMAND, reason: "invalid JSON payload" });
  setLocal('return_value', "ERROR: invalid JSON payload");
} else {
  routeCommand(COMMAND, payload);
}
