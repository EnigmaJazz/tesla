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
// boundaries, and protected preference migration.
// Slice C scope: the four operations APPLY_OVERRIDE, APPEND_OVERRIDE,
// SET_DEFAULT, and PRUNE (with retention/global pruning), plus C1 coverage
// in harness/test_single_writer.js.
// ==========================================

var OVR_FILE = "Tasker/Tesla/Data/TDS_Overrides.json";
var PREFS_FILE = "Tasker/Tesla/Data/TDS_Routine_Preferences.json";
var HANDLER_WRITER = "Override Handler";
var OVR_SCHEMA_VERSION = 2;
var PREFS_SCHEMA_VERSION = 2;

// Retention boundaries — named constants, never magic numbers.
var ROUTINE_RETENTION_SECS = 24 * 3600;  // 24-hour retention
var FUTURE_EXCLUSION_SECS = 12 * 3600;   // 12-hour future exclusion

// Strict occurrence-ID parsing (ID-2): split at lastIndexOf("_"); the core
// MAY contain underscores; the base-36 suffix MUST decode within the range.
var ID_SUFFIX_MIN_UNIX = 1e9;
var ID_SUFFIX_MAX_UNIX = 2.5e9;
var OVERRIDE_REGEX = /^([0-9a-zA-Z_]+)_([0-9a-zA-Z]+)$/;

// A categorized occurrence is proposed as a learned default only when the
// same exact route/mode has been seen this many times.
var LEARNED_DEFAULT_THRESHOLD = 3;

// Legacy preference keys migrated once on first Handler use.
var LEGACY_PREF_KEYS = ["Route_Defaults", "Route_History"];

// Category groups (OVR-10): adding to one category wipes only the exact
// conflicting-category keys for the same occurrence (never substrings).
var CATEGORY_GROUP_MODE = ["Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives", "Forced_Lift_Chains", "Forced_Drive_Chains"];
var CATEGORY_GROUP_PITSTOP = ["Skipped_Pitstops", "Forced_Pitstops"];
var CATEGORY_GROUP_STATE = ["Skipped_Events", "Trimmed_Events"];
var CATEGORY_GROUP_LATE = ["Ignored_Lateness"];
var CATEGORY_GROUP_WALK = ["Ignored_Walks"];

var ALL_CATEGORY_ARRAYS = CATEGORY_GROUP_MODE.concat(CATEGORY_GROUP_PITSTOP, CATEGORY_GROUP_STATE, CATEGORY_GROUP_LATE, CATEGORY_GROUP_WALK);

// Schema-v2 eventOverride fields keyed by category array (materialize + sync).
var MODE_FIELD_BY_ARRAY = {
  "Forced_Lifts": "lift", "Forced_Transit": "transit", "Forced_Walks": "walk",
  "Forced_Drives": "drive", "Forced_Lift_Chains": "lift_chain", "Forced_Drive_Chains": "drive_chain"
};
var ARRAY_BY_MODE_FIELD = {
  "lift": "Forced_Lifts", "transit": "Forced_Transit", "walk": "Forced_Walks",
  "drive": "Forced_Drives", "lift_chain": "Forced_Lift_Chains", "drive_chain": "Forced_Drive_Chains"
};

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
  const lastSep = rawId.lastIndexOf("_");
  if (lastSep <= 0 || lastSep === rawId.length - 1) {
    return rejectId(rawId, "malformed_format", component);
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
      if (readFile(path) !== snap.raw) {
        logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "snapshot restore read-back mismatch: " + path });
      }
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

// --- Schema-v2 materialization and projection sync -------------------------

function emptyOverrideEntry() {
  return { mode: null, skip: false, trimmedEndUnix: null, pitstop: null, ignoreLateness: null, ignoreWalk: false };
}

function appendCsvItem(csv, item) {
  if (!item) return csv || "";
  return csv ? (csv + "," + item) : item;
}

function materializeEventOverrides(ovr) {
  if (!hasExactKey(ovr, "eventOverrides") || !ovr.eventOverrides) ovr.eventOverrides = {};
  if (Object.keys(ovr.eventOverrides).length > 0) return;
  // First use after a legacy OVR: build the authoritative map from the CSV
  // projections. Projections remain compatibility views, never authorities.
  ALL_CATEGORY_ARRAYS.forEach(function (arr) {
    const csv = ovr[arr] || "";
    const items = csv.split(",");
    for (let i = 0; i < items.length; i++) {
      const occId = items[i].trim();
      if (!occId) continue;
      if (!hasExactKey(ovr.eventOverrides, occId)) ovr.eventOverrides[occId] = emptyOverrideEntry();
      const entry = ovr.eventOverrides[occId];
      const modeField = MODE_FIELD_BY_ARRAY[arr];
      if (modeField) entry.mode = modeField;
      else if (arr === "Skipped_Pitstops") entry.pitstop = "skipped";
      else if (arr === "Forced_Pitstops") entry.pitstop = "forced";
      else if (arr === "Skipped_Events") entry.skip = true;
      else if (arr === "Trimmed_Events") entry.trimmedEndUnix = 0; // legacy trim, end time unknown
      else if (arr === "Ignored_Lateness") entry.ignoreLateness = true;
      else if (arr === "Ignored_Walks") entry.ignoreWalk = true;
    }
  });
}

function syncProjections(ovr) {
  ALL_CATEGORY_ARRAYS.forEach(function (arr) { ovr[arr] = ""; });
  Object.keys(ovr.eventOverrides || {}).forEach(function (occId) {
    const entry = ovr.eventOverrides[occId];
    if (entry.mode) ovr[ARRAY_BY_MODE_FIELD[entry.mode]] = appendCsvItem(ovr[ARRAY_BY_MODE_FIELD[entry.mode]], occId);
    if (entry.pitstop === "skipped") ovr["Skipped_Pitstops"] = appendCsvItem(ovr["Skipped_Pitstops"], occId);
    else if (entry.pitstop === "forced") ovr["Forced_Pitstops"] = appendCsvItem(ovr["Forced_Pitstops"], occId);
    if (entry.skip) ovr["Skipped_Events"] = appendCsvItem(ovr["Skipped_Events"], occId);
    if (hasTrimmedEnd(entry)) ovr["Trimmed_Events"] = appendCsvItem(ovr["Trimmed_Events"], occId);
    if (entry.ignoreLateness) ovr["Ignored_Lateness"] = appendCsvItem(ovr["Ignored_Lateness"], occId);
    if (entry.ignoreWalk) ovr["Ignored_Walks"] = appendCsvItem(ovr["Ignored_Walks"], occId);
  });
}

function ensureSeries(prefs, seriesId, routeSig) {
  if (!hasExactKey(prefs.seriesPreferences, seriesId)) prefs.seriesPreferences[seriesId] = {};
  const routes = prefs.seriesPreferences[seriesId];
  if (!hasExactKey(routes, routeSig)) routes[routeSig] = { defaults: {}, history: {} };
  return routes[routeSig];
}

function materializeSeriesPreferences(prefs) {
  if (!hasExactKey(prefs, "seriesPreferences") || !prefs.seriesPreferences) prefs.seriesPreferences = {};
  if (Object.keys(prefs.seriesPreferences).length > 0) return;
  // First use after migration: promote legacy Route_Defaults/Route_History
  // CSV projections into the authoritative seriesPreferences map.
  const defItems = (prefs["Route_Defaults"] || "").split(",");
  for (let i = 0; i < defItems.length; i++) {
    const item = defItems[i].trim();
    if (!item) continue;
    const parts = item.split("^");
    if (parts.length < 4) continue;
    const coreId = parts[0];
    const routeSig = parts.slice(1, parts.length - 1).join("^");
    const modifier = parts[parts.length - 1];
    ensureSeries(prefs, coreId, routeSig).defaults[modifier] = true;
  }
  const histItems = (prefs["Route_History"] || "").split(",");
  for (let j = 0; j < histItems.length; j++) {
    const item = histItems[j].trim();
    if (!item) continue;
    const eqPos = item.indexOf("=");
    const keyPart = eqPos === -1 ? item : item.slice(0, eqPos);
    const count = eqPos === -1 ? 1 : parseInt(item.slice(eqPos + 1), 10);
    const parts = keyPart.split("^");
    if (parts.length < 4) continue;
    const coreId = parts[0];
    const routeSig = parts.slice(1, parts.length - 1).join("^");
    const modifier = parts[parts.length - 1];
    ensureSeries(prefs, coreId, routeSig).history[modifier] = isNaN(count) ? 1 : count;
  }
}

function syncPrefsProjection(prefs) {
  const defaults = [];
  const history = [];
  Object.keys(prefs.seriesPreferences || {}).forEach(function (seriesId) {
    Object.keys(prefs.seriesPreferences[seriesId]).forEach(function (routeSig) {
      const sp = prefs.seriesPreferences[seriesId][routeSig];
      Object.keys(sp.defaults).forEach(function (mod) {
        defaults.push(seriesId + "^" + routeSig + "^" + mod);
      });
      Object.keys(sp.history).forEach(function (mod) {
        history.push(seriesId + "^" + routeSig + "^" + mod + "=" + sp.history[mod]);
      });
    });
  });
  prefs["Route_Defaults"] = defaults.join(",");
  prefs["Route_History"] = history.join(",");
}

// --- Category semantics (CMD-9 / OVR-10) -----------------------------------

function categoryGroupFor(overrideKey) {
  if (CATEGORY_GROUP_MODE.indexOf(overrideKey) !== -1) return CATEGORY_GROUP_MODE;
  if (CATEGORY_GROUP_PITSTOP.indexOf(overrideKey) !== -1) return CATEGORY_GROUP_PITSTOP;
  if (CATEGORY_GROUP_STATE.indexOf(overrideKey) !== -1) return CATEGORY_GROUP_STATE;
  if (CATEGORY_GROUP_LATE.indexOf(overrideKey) !== -1) return CATEGORY_GROUP_LATE;
  if (CATEGORY_GROUP_WALK.indexOf(overrideKey) !== -1) return CATEGORY_GROUP_WALK;
  return null;
}

function modifierCategory(modifier) {
  if (modifier.indexOf("IGNORELATENESS") !== -1) return "LATENESS";
  if (modifier.indexOf("IGNOREWALK") !== -1) return "WALK";
  if (modifier.indexOf("SKIP") !== -1 || modifier.indexOf("TRIM") !== -1) return "STATE";
  if (modifier.indexOf("PITSTOP") !== -1) return "PITSTOP";
  return "MODE";
}

// Wipe the exact conflicting-category keys for one occurrence. The target
// category is never wiped; only the OTHER categories in the same group are
// reset (exact keys only).
function categorizedWipe(ovr, overrideKey, targetId) {
  const group = categoryGroupFor(overrideKey);
  if (!group) return;
  const entry = (ovr.eventOverrides || {})[targetId];
  if (!entry) return;
  for (let i = 0; i < group.length; i++) {
    const other = group[i];
    if (other === overrideKey) continue;
    const modeField = MODE_FIELD_BY_ARRAY[other];
    if (modeField) { if (entry.mode === modeField) entry.mode = null; }
    else if (other === "Skipped_Pitstops" || other === "Forced_Pitstops") { if (entry.pitstop === (other === "Skipped_Pitstops" ? "skipped" : "forced")) entry.pitstop = null; }
    else if (other === "Skipped_Events") { entry.skip = false; }
    else if (other === "Trimmed_Events") { entry.trimmedEndUnix = null; }
    else if (other === "Ignored_Lateness") { entry.ignoreLateness = null; }
    else if (other === "Ignored_Walks") { entry.ignoreWalk = false; }
  }
}

function isEmptyOverrideEntry(entry) {
  return !entry.mode && !entry.skip && !hasTrimmedEnd(entry) && !entry.pitstop && !entry.ignoreLateness && !entry.ignoreWalk;
}

// null/undefined = not trimmed; 0 = legacy trim with unknown end time;
// >0 = trimmed with a known end unix.
function hasTrimmedEnd(entry) {
  return entry.trimmedEndUnix !== null && entry.trimmedEndUnix !== undefined;
}

function entryHasCategory(entry, overrideKey) {
  if (!entry) return false;
  const modeField = MODE_FIELD_BY_ARRAY[overrideKey];
  if (modeField) return entry.mode === modeField;
  if (overrideKey === "Skipped_Pitstops") return entry.pitstop === "skipped";
  if (overrideKey === "Forced_Pitstops") return entry.pitstop === "forced";
  if (overrideKey === "Skipped_Events") return entry.skip === true;
  if (overrideKey === "Trimmed_Events") return hasTrimmedEnd(entry);
  if (overrideKey === "Ignored_Lateness") return entry.ignoreLateness === true;
  if (overrideKey === "Ignored_Walks") return entry.ignoreWalk === true;
  return false;
}

function applyCategory(entry, overrideKey, cmd) {
  const modeField = MODE_FIELD_BY_ARRAY[overrideKey];
  if (modeField) entry.mode = modeField;
  else if (overrideKey === "Skipped_Pitstops") entry.pitstop = "skipped";
  else if (overrideKey === "Forced_Pitstops") entry.pitstop = "forced";
  else if (overrideKey === "Skipped_Events") entry.skip = true;
  else if (overrideKey === "Trimmed_Events") entry.trimmedEndUnix = cmd && cmd.trimmedEndUnix ? cmd.trimmedEndUnix : nowSec();
  else if (overrideKey === "Ignored_Lateness") entry.ignoreLateness = true;
  else if (overrideKey === "Ignored_Walks") entry.ignoreWalk = true;
}

// Learn a categorized history entry (one per category per route). Returns the
// proposed default key when the count reaches 3, otherwise null.
function applyCategorizedHistory(prefs, coreId, routeSig, modeForHistory) {
  const sp = ensureSeries(prefs, coreId, routeSig);
  const targetCategory = modifierCategory(modeForHistory);
  if (hasExactKey(sp.defaults, modeForHistory)) return null;
  // Keep only the exact key in this category; drop other modifiers of the
  // same category for this route (exact-key, never substring).
  Object.keys(sp.history).forEach(function (mod) {
    if (mod !== modeForHistory && modifierCategory(mod) === targetCategory) delete sp.history[mod];
  });
  const count = (sp.history[modeForHistory] || 0) + 1;
  sp.history[modeForHistory] = count;
  if (count === LEARNED_DEFAULT_THRESHOLD) return coreId + "^" + routeSig + "^" + modeForHistory;
  return null;
}

// --- Operations (CMD-9) ------------------------------------------------------

function commandApplyOverride(cmd) {
  if (!cmd || typeof cmd !== "object") return { ok: false, reason: "missing_command" };
  const targetId = cmd.targetId;
  const overrideKey = cmd.overrideKey;
  if (!targetId || !overrideKey) return { ok: false, reason: "missing_targetId_or_overrideKey" };
  const parsed = parseOccurrenceId(targetId, HANDLER_WRITER);
  if (!parsed.ok) return { ok: false, reason: "id_parse_rejected" };

  const ovr = readOvr();
  const prefs = readPrefs();
  materializeEventOverrides(ovr);
  materializeSeriesPreferences(prefs);

  const existing = (ovr.eventOverrides || {})[targetId];
  let actionTaken = "";
  if (existing && entryHasCategory(existing, overrideKey)) {
    // Toggle OFF: remove only the exact key from the exact category.
    const modeField = MODE_FIELD_BY_ARRAY[overrideKey];
    if (modeField) existing.mode = null;
    else if (overrideKey === "Skipped_Pitstops" || overrideKey === "Forced_Pitstops") existing.pitstop = null;
    else if (overrideKey === "Skipped_Events") existing.skip = false;
    else if (overrideKey === "Trimmed_Events") existing.trimmedEndUnix = null;
    else if (overrideKey === "Ignored_Lateness") existing.ignoreLateness = null;
    else if (overrideKey === "Ignored_Walks") existing.ignoreWalk = false;
    if (isEmptyOverrideEntry(existing)) delete ovr.eventOverrides[targetId];
    actionTaken = "Removed";
  } else {
    // Toggle ON: wipe only exact conflicting categories, then set the key.
    if (!ovr.eventOverrides) ovr.eventOverrides = {};
    if (!hasExactKey(ovr.eventOverrides, targetId)) ovr.eventOverrides[targetId] = emptyOverrideEntry();
    categorizedWipe(ovr, overrideKey, targetId);
    applyCategory(ovr.eventOverrides[targetId], overrideKey, cmd);
    actionTaken = "Added";
  }

  syncProjections(ovr);
  writeOvr(ovr);

  let proposedDefault = null;
  if (actionTaken === "Added" && cmd.baseCmd && cmd.origCoords && cmd.destCoords) {
    const modeForHistory = cmd.baseCmd.replace("CHAIN", "");
    const routeSig = cmd.origCoords + "^" + cmd.destCoords;
    proposedDefault = applyCategorizedHistory(prefs, parsed.coreId, routeSig, modeForHistory);
    syncPrefsProjection(prefs);
    writePrefs(prefs);
  }
  if (proposedDefault) setLocal("propose_default", proposedDefault);
  return { ok: true, action: actionTaken, targetId: targetId, overrideKey: overrideKey };
}

function commandAppendOverride(cmd) {
  if (!cmd || typeof cmd !== "object") return { ok: false, reason: "missing_command" };
  const baseId = cmd.baseId;
  const targetArray = cmd.targetArray;
  if (!baseId || !targetArray) return { ok: false, reason: "missing_baseId_or_targetArray" };
  const parsed = parseOccurrenceId(baseId, HANDLER_WRITER);
  if (!parsed.ok) return { ok: false, reason: "id_parse_rejected" };

  const ovr = readOvr();
  const prefs = readPrefs();
  materializeEventOverrides(ovr);
  materializeSeriesPreferences(prefs);

  categorizedWipe(ovr, targetArray, baseId);
  if (!ovr.eventOverrides) ovr.eventOverrides = {};
  if (!hasExactKey(ovr.eventOverrides, baseId)) ovr.eventOverrides[baseId] = emptyOverrideEntry();
  applyCategory(ovr.eventOverrides[baseId], targetArray, cmd);
  if (cmd.alsoAppendLate) ovr.eventOverrides[baseId].ignoreLateness = true;

  syncProjections(ovr);
  writeOvr(ovr);

  let proposedDefault = null;
  if (cmd.routeSig && cmd.modeForHistory) {
    proposedDefault = applyCategorizedHistory(prefs, parsed.coreId, cmd.routeSig, cmd.modeForHistory);
    syncPrefsProjection(prefs);
    writePrefs(prefs);
  }
  if (proposedDefault) setLocal("propose_default", proposedDefault);
  return { ok: true, baseId: baseId, targetArray: targetArray };
}

function commandSetDefault(cmd) {
  if (!cmd || typeof cmd !== "object") return { ok: false, reason: "missing_command" };
  const targetKey = cmd.targetKey;
  const isSet = !!cmd.isSet;
  const clearAll = !!cmd.clearAll;
  if (!targetKey && !clearAll) return { ok: false, reason: "missing_targetKey" };

  const prefs = readPrefs();
  materializeSeriesPreferences(prefs);

  if (clearAll) {
    prefs.seriesPreferences = {};
    syncPrefsProjection(prefs);
    writePrefs(prefs);
    return { ok: true, action: "cleared_all" };
  }

  const tkParts = targetKey.split("^");
  if (tkParts.length < 4) return { ok: false, reason: "malformed_targetKey" };
  const coreId = tkParts[0];
  const routeSig = tkParts.slice(1, tkParts.length - 1).join("^");
  const modifier = tkParts[tkParts.length - 1];
  const targetCategory = modifierCategory(modifier);
  const sp = ensureSeries(prefs, coreId, routeSig);

  if (isSet) {
    sp.defaults[modifier] = true;
    // Setting a default stops further history accumulation for that category.
    Object.keys(sp.history).forEach(function (mod) {
      if (mod !== modifier && modifierCategory(mod) === targetCategory) delete sp.history[mod];
    });
  } else {
    // Wipe the exact category: drop the default and history for this route's
    // category (exact-key, never substring).
    Object.keys(sp.defaults).forEach(function (mod) {
      if (modifierCategory(mod) === targetCategory) delete sp.defaults[mod];
    });
    Object.keys(sp.history).forEach(function (mod) {
      if (modifierCategory(mod) === targetCategory) delete sp.history[mod];
    });
    if (Object.keys(sp.defaults).length === 0 && Object.keys(sp.history).length === 0) {
      delete prefs.seriesPreferences[coreId][routeSig];
      if (Object.keys(prefs.seriesPreferences[coreId]).length === 0) delete prefs.seriesPreferences[coreId];
    }
  }

  syncPrefsProjection(prefs);
  writePrefs(prefs);
  setLocal("cancel_id", coreId);
  return { ok: true, action: isSet ? "set" : "wiped", targetKey: targetKey };
}

function occurrenceWithinRetention(occId, nowSec, whitelistMap, departWindow) {
  if (whitelistMap && hasExactKey(whitelistMap, occId)) return true;
  const parsed = parseOccurrenceId(occId, HANDLER_WRITER);
  if (!parsed.ok) return false;
  const start = parsed.instanceStartUnix;
  // Bounded timing: 24-hour retention back; 12-hour future exclusion ahead.
  if (start > nowSec) return start <= nowSec + (departWindow || FUTURE_EXCLUSION_SECS);
  return start > nowSec - ROUTINE_RETENTION_SECS;
}

function commandPrune(cmd) {
  if (!cmd || typeof cmd !== "object") return { ok: false, reason: "missing_command" };
  const nowSec = cmd.nowSec;
  if (!nowSec) return { ok: false, reason: "missing_nowSec" };
  const whitelistMap = cmd.whitelistMap || {};

  const ovr = readOvr();
  const prefs = readPrefs();
  materializeEventOverrides(ovr);
  materializeSeriesPreferences(prefs);

  // Prune the authoritative eventOverrides map by exact occurrence retention.
  Object.keys(ovr.eventOverrides).forEach(function (occId) {
    if (!occurrenceWithinRetention(occId, nowSec, whitelistMap)) delete ovr.eventOverrides[occId];
  });
  syncProjections(ovr);
  writeOvr(ovr);

  // Phase 6 (REQ-6STATE-1/2): the four memory globals are trip-state-only.
  // Reducer state retention (30 days) owns departures/dropins/arrivals/stops
  // — the legacy GLOBAL_MEMORIES prune loop is gone, including the missing
  // TDS_Completed_Stops key that caused unbounded growth (SCN-6STATE-2).
  return { ok: true, action: "pruned" };
}

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
