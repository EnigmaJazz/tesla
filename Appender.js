// ==========================================
// UNIVERSAL APPENDER (V10.3 -> D1)
// Fully migrated to Tasker/Tesla/Data/ directory structure.
// D1 (RULE-8C): stages APPEND_OVERRIDE commands; the Override Handler
// performs categorized wiping, the category apply, and history learning.
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
    var choice = local('final_return') || "";
    var parts = choice.split("|");
    
    if (parts.length >= 2) {
        var rawCmd = parts[0].toUpperCase().replace(/_/g, "").trim();
        var data = parts[1].trim().replace(/\|/g, "~"); 
        var baseId = data.split("~")[0].trim(); 
        var routeSig = parts.length > 2 ? parts[2].trim() : ""; 
        var targetArray = "";

        if (rawCmd === "LIFT") targetArray = "Forced_Lifts";
        else if (rawCmd === "TRANSIT") targetArray = "Forced_Transit";
        else if (rawCmd === "WALK") targetArray = "Forced_Walks";
        else if (rawCmd === "DRIVE") targetArray = "Forced_Drives";
        else if (rawCmd === "SKIPEVENT" || rawCmd === "SKIP") targetArray = "Skipped_Events";
        else if (rawCmd === "LIFTCHAIN") targetArray = "Forced_Lift_Chains";
        else if (rawCmd === "DRIVECHAIN") targetArray = "Forced_Drive_Chains";
        else if (rawCmd === "SKIPPITSTOP") targetArray = "Skipped_Pitstops";
        else if (rawCmd === "FORCEPITSTOP") targetArray = "Forced_Pitstops"; 
        else if (rawCmd === "IGNORELATENESS" || rawCmd === "IGNOREDLATENESS") targetArray = "Ignored_Lateness";
        else if (rawCmd === "IGNOREWALK" || rawCmd === "IGNOREDWALK") targetArray = "Ignored_Walks";
        else if (rawCmd === "TRIMEVENT" || rawCmd === "TRIM") targetArray = "Trimmed_Events";

        // D1 (RULE-8C): The Override Handler owns TDS_Overrides.json. Appender
        // stages an APPEND_OVERRIDE command; the handler performs categorized
        // wiping, the category apply (including FORCEPITSTOP lateness), and
        // history learning (Route_History/Route_Defaults equivalent).
        if (targetArray !== "") {
            // [ID-2] Reject malformed/out-of-range occurrence IDs before staging.
            var parsedId = parseOccurrenceId(baseId, "Appender");
            if (!parsedId.ok) throw new Error("ID_PARSE_REJECTED: " + baseId + " (" + parsedId.reason + ")");

            // Mirror the legacy history semantics so learned keys stay identical.
            let baseCmd = rawCmd.replace("CHAIN", "").replace("ED", "");
            if (baseCmd === "SKIP") baseCmd = "SKIPEVENT";
            if (baseCmd === "TRIM") baseCmd = "TRIMEVENT";

            let modeForHistory = baseCmd;
            if (rawCmd.indexOf("LATENESS") !== -1) {
                const pref = data.split("~")[1];
                if (pref) modeForHistory += "~" + pref;
            }

            let targetCategory = "MODE";
            if (modeForHistory.indexOf("IGNORELATENESS") !== -1) targetCategory = "LATENESS";
            else if (modeForHistory.indexOf("IGNOREWALK") !== -1) targetCategory = "WALK";
            else if (modeForHistory.indexOf("SKIP") !== -1 || modeForHistory.indexOf("TRIM") !== -1) targetCategory = "STATE";

            setLocal('par1', 'APPEND_OVERRIDE');
            setLocal('par2', JSON.stringify({
                baseId: baseId,
                targetArray: targetArray,
                routeSig: routeSig,
                modeForHistory: modeForHistory,
                targetCategory: targetCategory,
                alsoAppendLate: rawCmd === "FORCEPITSTOP"
            }));
        }
    }
} catch(e) { flash("Appender Error: " + e.message); } 
