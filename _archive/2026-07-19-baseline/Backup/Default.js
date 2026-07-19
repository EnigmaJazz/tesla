// ==========================================
// TDS DEFAULT MANAGER (v1.2 True History Wipe)
// Unified script to Set or Wipe Defaults in JSON.
// Strips mode from signature to completely wipe all competing route history.
// ==========================================

try {
    var fullCmd = local('command_text') || local('par1') || "";
    var isSet = fullCmd.indexOf("TDS_SET_DEFAULT") !== -1;
    
    // Clean all command prefixes off the target key
    var targetKey = fullCmd.replace("TDS_SET_DEFAULT|", "").replace("TDS_CLEAR_DEFAULT|", "").replace("CLEAR_DEFAULT|", "").trim();

    var filePath = "Tasker/Tesla/Data/TDS_Overrides.json";
    var rawFile = readFile(filePath) || "{}";
    var mem = {};
    try { mem = JSON.parse(rawFile); } catch(e) {}
    
    if (!mem.Route_Defaults) mem.Route_Defaults = "";
    if (!mem.Route_History) mem.Route_History = "";

    if (targetKey.toUpperCase() === "ALL") {
        mem.Route_Defaults = "";
        mem.Route_History = "";
    } else if (targetKey !== "") {
        
        // Isolate the base routine signature by stripping the transport mode
        var tkParts = targetKey.split("^");
        var routineKey = targetKey;
        if (tkParts.length > 3) {
            tkParts.pop(); // Remove the mode (e.g., "DRIVE")
            routineKey = tkParts.join("^");
        }

        if (isSet) {
            // SET DEFAULT
            var exDef = mem.Route_Defaults;
            if (exDef.indexOf(targetKey) === -1) {
                mem.Route_Defaults = exDef ? (exDef + "," + targetKey) : targetKey;
            }
        } else {
            // WIPE DEFAULT 
            var dArr = mem.Route_Defaults.split(","); var dKeep = [];
            for (var i = 0; i < dArr.length; i++) {
                // Wipe anything matching the base routine signature
                if (dArr[i].indexOf(routineKey) === -1 && dArr[i].trim() !== "") dKeep.push(dArr[i]);
            }
            mem.Route_Defaults = dKeep.join(",");
        }

        // Clean out the History Array entirely for this route
        var hArr = mem.Route_History.split(","); var hKeep = [];
        for (var j = 0; j < hArr.length; j++) {
            if (hArr[j].indexOf(routineKey) === -1 && hArr[j].trim() !== "") hKeep.push(hArr[j]);
        }
        mem.Route_History = hKeep.join(",");
        
        // Export coreId for AutoNotification Cancel
        setLocal('cancel_id', targetKey.split("^")[0]);
    }

    writeFile(filePath, JSON.stringify(mem), false);

} catch(e) { flash("Default Manager Error: " + e.message); }