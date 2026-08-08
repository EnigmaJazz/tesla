// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";

// ==========================================
// TDS OVERRIDE INJECTOR (v1.1 -> D1)
// Reads an Event ID from the committed itinerary and stages an
// APPLY_OVERRIDE command for the Override Handler (RULE-8C), which
// toggles the exact key, performs categorized wiping, and learns history.
// ==========================================

// [ID-2] Strict occurrence-ID parsing (inlined copy; canonical: ID_Parser.js).
// Occurrence IDs are <coreId>_<base36StartUnix>; cores may contain underscores,
// so the split uses lastIndexOf("_"). Malformed/out-of-range IDs flash
// ID_PARSE_REJECTED and skip the rejected work (no apply).
const ID_SUFFIX_MIN_UNIX = 1e9;
const ID_SUFFIX_MAX_UNIX = 2.5e9;
const ID_OCCURRENCE_REGEX = /^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$/;

function parseOccurrenceId(rawId, component) {
    component = component || "ID_Parser";
    if (typeof rawId !== "string" || rawId.length === 0) {
        return rejectOccurrenceId(rawId, "empty_id", component);
    }
    const lastSep = rawId.lastIndexOf("_");
    if (lastSep <= 0 || lastSep === rawId.length - 1) {
        return rejectOccurrenceId(rawId, "malformed_format", component);
    }
    const match = ID_OCCURRENCE_REGEX.exec(rawId);
    if (!match) {
        return rejectOccurrenceId(rawId, "malformed_format", component);
    }
    const suffixNum = parseInt(match[2], 36);
    if (isNaN(suffixNum) || suffixNum < ID_SUFFIX_MIN_UNIX || suffixNum >= ID_SUFFIX_MAX_UNIX) {
        return rejectOccurrenceId(rawId, "invalid_suffix", component);
    }
    return { ok: true, coreId: match[1], instanceStartUnix: suffixNum, rawId: rawId };
}

function rejectOccurrenceId(rawId, reason, component) {
    flash(JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        generationId: null,
        component: component,
        severity: "WARN",
        code: "ID_PARSE_REJECTED",
        tripId: null,
        details: { rawId: rawId, reason: reason }
    }));
    return { ok: false, reason: reason };
}

try {
    // Expected Inputs from Tasker
    let idx = parseInt(local('par1'), 10); 
    let overrideKey = local('par2'); // e.g., "Forced_Pitstops"
    
    if (isNaN(idx) || !overrideKey) throw new Error("Missing parameters");

    // 1. Extract Target ID and Coordinates from the committed itinerary.
    // Canonical Phase 2 resolver (inlined local copy; algorithm source of
    // truth: TDS_Helper.js readActiveGeneration) with legacy fallback.
    const PHASE2_MANIFEST_PATH = DATA_ROOT + "TDS_Run_Manifest.json";
    const PHASE2_DATA_DIR = DATA_ROOT;
    function encodeGen(g) { return String(g).replace(/:/g, "_"); }
    function pathFor(g, kind) {
      return PHASE2_DATA_DIR + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + encodeGen(g) + ".json";
    }
    function readJson(path) {
      const raw = readFile(path) || "";
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    function readActiveGeneration(kind) {
      const m = readJson(PHASE2_MANIFEST_PATH);
      const key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
      if (m && m.state === "committed" && m.activeGeneration) {
        const data = readJson(m[key] || pathFor(m.activeGeneration, kind));
        if (data !== null) return data;
      }
      if (m && m.previousGeneration) {
        const data = readJson(pathFor(m.previousGeneration, kind));
        if (data !== null) return data;
      }
      const legacyItin = readJson(PHASE2_DATA_DIR + "Itin_Master.json");
      if (legacyItin !== null) return legacyItin;
      return [];
    }
    let itin = readActiveGeneration("itinerary");
    
    if (idx >= itin.length) throw new Error("Itinerary index out of bounds");
    let targetId = itin[idx].targetEventId;
    if (!targetId || targetId === "MANUAL_RETURN") throw new Error("Cannot override a manual return leg");

    let destCoords = itin[idx].targetCoords || "0,0";
    let origCoords = (idx > 0 && itin[idx-1].targetCoords) ? itin[idx-1].targetCoords : (global('User_Loc') || "0,0");

    // 2. [ID-2] Reject malformed/out-of-range occurrence IDs before staging.
    let parsedId = parseOccurrenceId(targetId, "Override_Injector");
    if (!parsedId.ok) throw new Error("ID_PARSE_REJECTED: " + targetId + " (" + parsedId.reason + ")");

    // 3. Map the override key to the base command the handler learns from.
    let baseCmd = "";
    if (overrideKey === "Forced_Lifts") baseCmd = "LIFT";
    else if (overrideKey === "Forced_Transit") baseCmd = "TRANSIT";
    else if (overrideKey === "Forced_Walks") baseCmd = "WALK";
    else if (overrideKey === "Forced_Drives") baseCmd = "DRIVE";
    else if (overrideKey === "Forced_Lift_Chains") baseCmd = "LIFTCHAIN";
    else if (overrideKey === "Forced_Drive_Chains") baseCmd = "DRIVECHAIN";
    else if (overrideKey === "Skipped_Pitstops") baseCmd = "SKIPPITSTOP";
    else if (overrideKey === "Forced_Pitstops") baseCmd = "FORCEPITSTOP";
    else if (overrideKey === "Skipped_Events") baseCmd = "SKIPEVENT";
    else if (overrideKey === "Trimmed_Events") baseCmd = "TRIMEVENT";

    // 4. D1 (RULE-8C): The Override Handler owns TDS_Overrides.json. The
    // injector stages an APPLY_OVERRIDE command; the handler toggles the
    // exact key, performs categorized wiping, and learns route history.
    setLocal('par1', 'APPLY_OVERRIDE');
    setLocal('par2', JSON.stringify({
        targetId: targetId,
        overrideKey: overrideKey,
        origCoords: origCoords,
        destCoords: destCoords,
        baseCmd: baseCmd
    }));

    setLocal('ui_return_msg', "Override staged: " + targetId + " to " + overrideKey);
    setLocal('do_engine_rerun', "true");

} catch(e) {
    setLocal('ui_return_msg', "Injector Error: " + e.message);
    setLocal('do_engine_rerun', "false");
    flash(local('ui_return_msg'));
}