// ==========================================
// TDS OVERRIDE INJECTOR (v1.1)
// Reads an Event ID from Itin_Master and toggles it in TDS_Overrides.
// Upgraded with Categorized Wiping and Route History integration.
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

    // 1. Extract Target ID and Coordinates from Itin_Master
    let itinRaw = "";
    try { itinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]"; } catch(e) { itinRaw = "[]"; }
    let itin = JSON.parse(itinRaw);
    
    if (idx >= itin.length) throw new Error("Itinerary index out of bounds");
    let targetId = itin[idx].targetEventId;
    if (!targetId || targetId === "MANUAL_RETURN") throw new Error("Cannot override a manual return leg");

    let destCoords = itin[idx].targetCoords || "0,0";
    let origCoords = (idx > 0 && itin[idx-1].targetCoords) ? itin[idx-1].targetCoords : (global('User_Loc') || "0,0");

    // 2. Read existing Overrides
    let ovrRaw = "";
    try { ovrRaw = readFile("Tasker/Tesla/Data/TDS_Overrides.json") || "{}"; } catch(e) { ovrRaw = "{}"; }
    let OVR = JSON.parse(ovrRaw);

    if (!OVR["Route_Defaults"]) OVR["Route_Defaults"] = "";
    if (!OVR["Route_History"]) OVR["Route_History"] = "";

    // 3. Define Categorized Wiping Arrays
    let catMode = ["Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives", "Forced_Lift_Chains", "Forced_Drive_Chains"];
    let catPitstop = ["Skipped_Pitstops", "Forced_Pitstops"];
    let catState = ["Skipped_Events", "Trimmed_Events"];
    let catLate = ["Ignored_Lateness"];
    let catWalk = ["Ignored_Walks"];

    let activeCategoryArrays = [];
    if (catMode.indexOf(overrideKey) !== -1) activeCategoryArrays = catMode;
    else if (catPitstop.indexOf(overrideKey) !== -1) activeCategoryArrays = catPitstop;
    else if (catState.indexOf(overrideKey) !== -1) activeCategoryArrays = catState;
    else if (catLate.indexOf(overrideKey) !== -1) activeCategoryArrays = catLate;
    else if (catWalk.indexOf(overrideKey) !== -1) activeCategoryArrays = catWalk;

    // 4. Toggle the ID
    let currentVal = OVR[overrideKey] || "";
    let valArr = currentVal.split(",").filter(function(v) { return v.trim() !== ""; });
    
    let indexPos = valArr.indexOf(targetId);
    let actionTaken = "";

    if (indexPos === -1) {
        // [SURGICAL UPGRADE: Categorized Wiping before adding]
        for (let i = 0; i < activeCategoryArrays.length; i++) {
            let arrName = activeCategoryArrays[i];
            if (arrName === overrideKey) continue; 

            if (OVR[arrName] && OVR[arrName].indexOf(targetId) !== -1) {
                let items = OVR[arrName].split(",");
                let kept = [];
                for (let j = 0; j < items.length; j++) {
                    if (items[j].indexOf(targetId) === -1 && items[j].trim() !== "") kept.push(items[j]);
                }
                OVR[arrName] = kept.join(",");
            }
        }
        
        valArr.push(targetId);
        actionTaken = "Added";
    } else {
        valArr.splice(indexPos, 1);
        actionTaken = "Removed";
    }

    OVR[overrideKey] = valArr.join(",");

    // 5. [SURGICAL UPGRADE: Route History Integration]
    if (actionTaken === "Added") {
        // [ID-2] Reject malformed/out-of-range occurrence IDs before persisting.
        let parsedId = parseOccurrenceId(targetId, "Override_Injector");
        if (!parsedId.ok) throw new Error("ID_PARSE_REJECTED: " + targetId + " (" + parsedId.reason + ")");
        let coreId = parsedId.coreId;
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

        if (baseCmd !== "") {
            let modeForHistory = baseCmd.replace("CHAIN", "");
            let targetCategory = "MODE";
            if (modeForHistory.indexOf("SKIP") !== -1 || modeForHistory.indexOf("TRIM") !== -1) targetCategory = "STATE";
            else if (modeForHistory.indexOf("PITSTOP") !== -1) targetCategory = "PITSTOP";

            // coreId comes from the strict occurrence-ID parse above (lastIndexOf("_")).
            let routeSig = origCoords + "^" + destCoords;
            let histKey = coreId + "^" + routeSig + "^" + modeForHistory;

            if (OVR["Route_Defaults"].indexOf(histKey) === -1) {
                let histRaw = OVR["Route_History"];
                let hParts = histRaw ? histRaw.split(",") : [];
                let newHist = [];
                let count = 1;

                for (let h = 0; h < hParts.length; h++) {
                    if (!hParts[h]) continue;
                    let hp = hParts[h].split("=");
                    let storedKey = hp[0];

                    if (storedKey.indexOf(coreId + "^" + routeSig) === 0) {
                        if (storedKey === histKey) {
                            count = parseInt(hp[1], 10) + 1;
                        } else {
                            let curMod = storedKey.split("^").pop();
                            let curCat = "MODE";
                            if (curMod.indexOf("IGNORELATENESS") !== -1) curCat = "LATENESS";
                            else if (curMod.indexOf("IGNOREWALK") !== -1) curCat = "WALK";
                            else if (curMod.indexOf("SKIP") !== -1 || curMod.indexOf("TRIM") !== -1) curCat = "STATE";

                            if (curCat !== targetCategory) {
                                newHist.push(hParts[h]);
                            }
                        }
                    } else {
                        newHist.push(hParts[h]);
                    }
                }

                newHist.push(histKey + "=" + count);
                OVR["Route_History"] = newHist.join(",");

                if (count === 3) setLocal('propose_default', histKey);
            }
        }
    }
    
    writeFile("Tasker/Tesla/Data/TDS_Overrides.json", JSON.stringify(OVR), false);
    
    setLocal('ui_return_msg', actionTaken + " " + targetId + " to " + overrideKey);
    setLocal('do_engine_rerun', "true");

} catch(e) {
    setLocal('ui_return_msg', "Injector Error: " + e.message);
    setLocal('do_engine_rerun', "false");
    flash(local('ui_return_msg'));
}