// ==========================================
// TDS OVERRIDE HANDLER — Slice B shell.
// Sole writer for TDS_Overrides.json and
// TDS_Routine_Preferences.json (RULE-8C).
//
// Design contract
// ---------------
// Entry-point shape mirrors Trip_State_Reducer.js: a Tasker action passes
// %par1 (operation) and %par2 (JSON payload); the Handler stages the result
// back through %return_value. Commands are validated with strict
// occurrence-ID parsing and exact-key maps (never substrings, OVR-10).
//
// Schema-v2 stores (authoritative):
//   OVR   {"schemaVersion":2,"eventOverrides":{"<occId>":{...}}}
//   PREFS {"schemaVersion":2,"seriesPreferences":{"<seriesId>":{...}}}
// Legacy top-level override arrays and Route_Defaults/Route_History remain as
// compatibility projections for scoped readers; projections are NEVER
// membership authorities. First use migrates legacy preference strings once
// into PREFS, removes them from OVR, and retains exact bytes/absence for
// rollback.
//
// Slice B scope: shell, schema-v2 stores, exact-key helpers, retention
// boundaries, and protected preference migration. The four operations
// (APPLY_OVERRIDE, APPEND_OVERRIDE, SET_DEFAULT, PRUNE) land in Slice C.
// ==========================================

var OVR_FILE = "Tasker/Tesla/Data/TDS_Overrides.json";
var PREFS_FILE = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";
var HANDLER_WRITER = "Override Handler";
var OVR_SCHEMA_VERSION = 2;
var PREFS_SCHEMA_VERSION = 2;

// Retention boundaries — named constants, never magic numbers.
var DEPART_WINDOW_SECS = 4 * 3600;       // four-hour Depart window
var ROUTINE_RETENTION_SECS = 24 * 3600;  // 24-hour retention
var FUTURE_EXCLUSION_SECS = 12 * 3600;   // 12-hour future exclusion

// Strict occurrence-ID parsing (ID-2): split at lastIndexOf("_"); the core
// MAY contain underscores; the base-36 suffix MUST decode within the range.
var ID_SUFFIX_MIN_UNIX = 1e9;
var ID_SUFFIX_MAX_UNIX = 2.5e9;
var OVERRIDE_REGEX = /^([0-9a-zA-Z_]+)_([0-9a-zA-Z]+)$/;

// Legacy preference keys migrated once on first Handler use.
var LEGACY_PREF_KEYS = ["Route_Defaults", "Route_History"];

function nowSec() { return Math.floor(Date.now() / 1000); }

function logEvent(severity, code, tripId, details) {
  flash(JSON.stringify({
    timestamp: Date.now(),
    generationId: details && details.generationId || null,
    component: HANDLER_WRITER,
    severity: severity,
    code: code,
    tripId: tripId || null,
    details: details || {}
  }));
}

function readJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    logEvent("warn", "OVERRIDE_FILE_PARSE_FAILED", null, { path: path, reason: e.message });
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

// Exact-key membership — never substring matching for IDs (OVR-10).
function hasExactKey(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// Remove exactly one CSV member; a longer ID that merely contains the target
// as a substring stays untouched (Substring decoy scenario).
function exactKeyRemove(arrayStr, targetId) {
  const items = (arrayStr || "").split(",");
  const itemMap = {};
  for (let i = 0; i < items.length; i++) {
    const key = items[i].trim();
    if (key) itemMap[key] = true;
  }
  if (hasExactKey(itemMap, targetId)) {
    delete itemMap[targetId];
    return Object.keys(itemMap).join(",");
  }
  return arrayStr || "";
}

function parseOccurrenceId(rawId, component) {
  if (typeof rawId !== "string" || rawId.length === 0) {
    return rejectId(rawId, "empty_id", component);
  }
  const match = OVERRIDE_REGEX.exec(rawId);
  if (!match) {
    return rejectId(rawId, "malformed_format", component);
  }
  const suffixNum = parseInt(match[2], 36);
  if (isNaN(suffixNum) || suffixNum < ID_SUFFIX_MIN_UNIX || suffixNum >= ID_SUFFIX_MAX_UNIX) {
    return rejectId(rawId, "invalid_suffix", component);
  }
  return { ok: true, coreId: match[1], instanceStartUnix: suffixNum, rawId: rawId };
}

function rejectId(rawId, reason, component) {
  flash(JSON.stringify({
    timestamp: Date.now(),
    generationId: null,
    component: component || HANDLER_WRITER,
    severity: "WARN",
    code: "ID_PARSE_REJECTED",
    tripId: null,
    details: { rawId: rawId, reason: reason }
  }));
  return { ok: false, reason: reason };
}

// --- Schema-v2 stores ----------------------------------------------------

function readOvr() {
  const obj = readJson(OVR_FILE) || {};
  if (obj.schemaVersion === OVR_SCHEMA_VERSION) return obj;
  // Legacy OVR: promote to schema-v2, keep top-level arrays as projections.
  const out = { schemaVersion: OVR_SCHEMA_VERSION, eventOverrides: {} };
  Object.keys(obj).forEach(function (k) {
    if (k !== "schemaVersion") out[k] = obj[k];
  });
  return out;
}

function readPrefs() {
  const obj = readJson(PREFS_FILE) || {};
  if (obj.schemaVersion === PREFS_SCHEMA_VERSION) return obj;
  const out = { schemaVersion: PREFS_SCHEMA_VERSION, seriesPreferences: {} };
  Object.keys(obj).forEach(function (k) {
    if (k !== "schemaVersion") out[k] = obj[k];
  });
  return out;
}

function writeOvr(ovr) {
  writeWithReadback(OVR_FILE, JSON.stringify(ovr), HANDLER_WRITER);
}

function writePrefs(prefs) {
  writeWithReadback(PREFS_FILE, JSON.stringify(prefs), HANDLER_WRITER);
}

// --- Protected preference migration -------------------------------------

function migrateLegacyPreferences(ovr, prefs) {
  let mutated = false;
  for (let i = 0; i < LEGACY_PREF_KEYS.length; i++) {
    const key = LEGACY_PREF_KEYS[i];
    if (hasExactKey(ovr, key) && !hasExactKey(prefs, key)) {
      prefs[key] = ovr[key];
      delete ovr[key];
      mutated = true;
    }
  }
  return mutated;
}

function restoreSnapshot(path, snap) {
  try {
    if (snap.existed) {
      writeFile(path, snap.raw);
    } else {
      deleteFile(path);
    }
  } catch (e) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "snapshot restore failed: " + path + ": " + e.message });
  }
}

// First use migrates legacy Route_Defaults/Route_History once. PREFS commits
// first, OVR second, each with exact read-back; any failure restores the
// exact prior bytes (or absence) of both resources and returns ERROR.
function ensureMigrated() {
  const ovrRaw = readFile(OVR_FILE) || "";
  const prefsRaw = readFile(PREFS_FILE) || "";
  const ovrSnap = { existed: ovrRaw !== "", raw: ovrRaw };
  const prefsSnap = { existed: prefsRaw !== "", raw: prefsRaw };
  const ovr = readOvr();
  const prefs = readPrefs();
  if (!migrateLegacyPreferences(ovr, prefs)) return { ok: true, migrated: false };
  try {
    writePrefs(prefs);  // PREFS first
    writeOvr(ovr);      // OVR second
    logEvent("info", "PREFERENCE_MIGRATION_COMMITTED", null, {});
    return { ok: true, migrated: true };
  } catch (e) {
    restoreSnapshot(PREFS_FILE, prefsSnap);
    restoreSnapshot(OVR_FILE, ovrSnap);
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "migration failed: " + e.message });
    return { ok: false, reason: e.message };
  }
}

// --- Command dispatch ------------------------------------------------------

function handler(op, payload) {
  if (typeof op !== "string" || !op) return { ok: false, reason: "missing_command" };
  const migration = ensureMigrated();
  if (!migration.ok) return { ok: false, reason: "migration_failed: " + migration.reason };
  if (op === "APPLY_OVERRIDE") return commandApplyOverride(payload);
  if (op === "APPEND_OVERRIDE") return commandAppendOverride(payload);
  if (op === "SET_DEFAULT") return commandSetDefault(payload);
  if (op === "PRUNE") return commandPrune(payload);
  return { ok: false, reason: "unknown_op: " + op };
}

// Slice C (PR C) implements the four operations with RED coverage. Slice B
// declares the dispatch contract; these stubs are replaced by C2.
function commandApplyOverride(payload) { return { ok: false, reason: "not_implemented_slice_c" }; }
function commandAppendOverride(payload) { return { ok: false, reason: "not_implemented_slice_c" }; }
function commandSetDefault(payload) { return { ok: false, reason: "not_implemented_slice_c" }; }
function commandPrune(payload) { return { ok: false, reason: "not_implemented_slice_c" }; }

// --- Entry point (Tasker action staging, mirrors Trip_State_Reducer) -------

var COMMAND = local("par1") || "";
var PAYLOAD_RAW = local("par2") || "";
var payload = null;
try { payload = PAYLOAD_RAW ? JSON.parse(PAYLOAD_RAW) : {}; } catch (e) { payload = null; }

if (!COMMAND) {
  setLocal("return_value", "ERROR: missing command");
} else if (payload === null) {
  logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "invalid JSON payload" });
  setLocal("return_value", "ERROR: invalid JSON payload");
} else {
  try { setLocal("return_value", JSON.stringify(handler(COMMAND, payload))); } catch (e) { setLocal("return_value", "ERROR: " + e.message); }
}
