// ==========================================
// TDS OVERRIDE INJECTOR (v1.0)
// Reads an Event ID from Itin_Master and toggles it in TDS_Overrides.
// ==========================================

try {
    // Expected Inputs from Tasker
    let idx = parseInt(local('par1'), 10); 
    let overrideKey = local('par2'); // e.g., "Forced_Pitstops"
    
    if (isNaN(idx) || !overrideKey) throw new Error("Missing parameters");

    // 1. Extract Target ID from Itin_Master
    let itinRaw = "";
    try { itinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]"; } catch(e) { itinRaw = "[]"; }
    let itin = JSON.parse(itinRaw);
    
    if (idx >= itin.length) throw new Error("Itinerary index out of bounds");
    let targetId = itin[idx].targetEventId;
    if (!targetId || targetId === "MANUAL_RETURN") throw new Error("Cannot override a manual return leg");

    // 2. Read existing Overrides
    let ovrRaw = "";
    try { ovrRaw = readFile("Tasker/Tesla/Data/TDS_Overrides.json") || "{}"; } catch(e) { ovrRaw = "{}"; }
    let OVR = JSON.parse(ovrRaw);

    // 3. Toggle the ID in the requested category
    let currentVal = OVR[overrideKey] || "";
    let valArr = currentVal.split(",").filter(function(v) { return v.trim() !== ""; });
    
    let indexPos = valArr.indexOf(targetId);
    let actionTaken = "";

    if (indexPos === -1) {
        valArr.push(targetId);
        actionTaken = "Added";
    } else {
        valArr.splice(indexPos, 1);
        actionTaken = "Removed";
    }

    OVR[overrideKey] = valArr.join(",");
    
    // 4. Save and prep for Engine Rerun
    writeFile("Tasker/Tesla/Data/TDS_Overrides.json", JSON.stringify(OVR), false);
    
    setLocal('ui_return_msg', actionTaken + " " + targetId + " to " + overrideKey);
    setLocal('do_engine_rerun', "true");

} catch(e) {
    setLocal('ui_return_msg', "Injector Error: " + e.message);
    setLocal('do_engine_rerun', "false");
    flash(local('ui_return_msg'));
}