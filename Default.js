// ==========================================
// TDS DEFAULT MANAGER (v1.3 Smart Categorization)
// Unified script to Set or Wipe Defaults in JSON.
// Separates Mode, Lateness, and Walk histories so they don't wipe each other.
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
        
        var tkParts = targetKey.split("^");
        var baseRoutineKey = targetKey;
        var modifier = "";
        var targetCategory = "MODE";

        if (tkParts.length > 3) {
            modifier = tkParts.pop(); 
            baseRoutineKey = tkParts.join("^"); 

            // [SURGICAL UPGRADE: Categorize the modifier to prevent collateral damage]
            if (modifier.indexOf("IGNORELATENESS") !== -1) targetCategory = "LATENESS";
            else if (modifier.indexOf("IGNOREWALK") !== -1) targetCategory = "WALK";
            else if (modifier.indexOf("SKIP") !== -1 || modifier.indexOf("TRIM") !== -1) targetCategory = "STATE";
        }

        if (isSet) {
            // SET DEFAULT
            var exDef = mem.Route_Defaults;
            if (exDef.indexOf(targetKey) === -1) {
                mem.Route_Defaults = exDef ? (exDef + "," + targetKey) : targetKey;
            }
        } else {
            // WIPE DEFAULT (Only wipe competing defaults in the same category)
            var dArr = mem.Route_Defaults.split(","); var dKeep = [];
            for (var i = 0; i < dArr.length; i++) {
                var curKey = dArr[i].trim();
                if (curKey === "") continue;
                
                var isMatch = false;
                if (curKey.indexOf(baseRoutineKey) === 0) {
                    var curMod = curKey.split("^").pop();
                    var curCat = "MODE";
                    if (curMod.indexOf("IGNORELATENESS") !== -1) curCat = "LATENESS";
                    else if (curMod.indexOf("IGNOREWALK") !== -1) curCat = "WALK";
                    else if (curMod.indexOf("SKIP") !== -1 || curMod.indexOf("TRIM") !== -1) curCat = "STATE";
                    
                    if (curCat === targetCategory) isMatch = true;
                }
                if (!isMatch) dKeep.push(curKey);
            }
            mem.Route_Defaults = dKeep.join(",");
        }

        // Clean out the History Array entirely for this specific category and route
        var hArr = mem.Route_History.split(","); var hKeep = [];
        for (var j = 0; j < hArr.length; j++) {
            var curKey = hArr[j].trim();
            if (curKey === "") continue;

            var isMatch = false;
            var histBase = curKey.split("=")[0]; // strip the count multiplier
            
            if (histBase.indexOf(baseRoutineKey) === 0) {
                var curMod = histBase.split("^").pop();
                var curCat = "MODE";
                if (curMod.indexOf("IGNORELATENESS") !== -1) curCat = "LATENESS";
                else if (curMod.indexOf("IGNOREWALK") !== -1) curCat = "WALK";
                else if (curMod.indexOf("SKIP") !== -1 || curMod.indexOf("TRIM") !== -1) curCat = "STATE";
                
                if (curCat === targetCategory) isMatch = true;
            }
            if (!isMatch) hKeep.push(curKey);
        }
        mem.Route_History = hKeep.join(",");
        
        // Export coreId for AutoNotification Cancel
        setLocal('cancel_id', targetKey.split("^")[0]);
    }

    writeFile(filePath, JSON.stringify(mem), false);

} catch(e) { flash("Default Manager Error: " + e.message); }
