// ==========================================
// UNIVERSAL APPENDER (V10.3)
// Fully migrated to Tasker/Tesla/Data/ directory structure.
// Categorized wiping protects orthogonal overrides and history streaks.
// ==========================================
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

        var allArrays = [ "Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives", "Skipped_Events", "Forced_Lift_Chains", "Forced_Drive_Chains", "Skipped_Pitstops", "Forced_Pitstops", "Ignored_Lateness", "Ignored_Walks", "Trimmed_Events", "Route_History", "Route_Defaults" ];

        var filePath = "Tasker/Tesla/Data/TDS_Overrides.json";
        var rawFile = readFile(filePath) || "{}";
        var mem = {};
        try { mem = JSON.parse(rawFile); } catch(e) {}
        
        for (var i = 0; i < allArrays.length; i++) {
            if (!mem[allArrays[i]]) mem[allArrays[i]] = "";
        }

        if (targetArray !== "") {
            // [SURGICAL UPGRADE: Categorized Event Wiping]
            var catMode = ["Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives", "Forced_Lift_Chains", "Forced_Drive_Chains"];
            var catPitstop = ["Skipped_Pitstops", "Forced_Pitstops"];
            var catState = ["Skipped_Events", "Trimmed_Events"];
            var catLate = ["Ignored_Lateness"];
            var catWalk = ["Ignored_Walks"];

            var activeCategoryArrays = [];
            if (catMode.indexOf(targetArray) !== -1) activeCategoryArrays = catMode;
            else if (catPitstop.indexOf(targetArray) !== -1) activeCategoryArrays = catPitstop;
            else if (catState.indexOf(targetArray) !== -1) activeCategoryArrays = catState;
            else if (catLate.indexOf(targetArray) !== -1) activeCategoryArrays = catLate;
            else if (catWalk.indexOf(targetArray) !== -1) activeCategoryArrays = catWalk;

            for (var i = 0; i < activeCategoryArrays.length; i++) { 
                var arrName = activeCategoryArrays[i];
                if (mem[arrName].indexOf(baseId) !== -1) {
                    var items = mem[arrName].split(","); var kept = [];
                    for (var j = 0; j < items.length; j++) if (items[j].indexOf(baseId) === -1 && items[j].trim() !== "") kept.push(items[j]);
                    mem[arrName] = kept.join(",");
                }
            }

            var ex = mem[targetArray];
            mem[targetArray] = ex ? (ex + "," + data) : data;
            
            if (rawCmd === "FORCEPITSTOP") {
                var exLate = mem["Ignored_Lateness"];
                mem["Ignored_Lateness"] = exLate ? (exLate + "," + data) : data;
            }

            // [SURGICAL UPGRADE: Universal State Tracker with Categorized Streaks]
            if (routeSig !== "") {
                var baseCmd = rawCmd.replace("CHAIN", "").replace("ED", ""); 
                if (baseCmd === "SKIP") baseCmd = "SKIPEVENT";
                if (baseCmd === "TRIM") baseCmd = "TRIMEVENT";
                
                var modeForHistory = baseCmd;
                if (rawCmd.indexOf("LATENESS") !== -1) {
                    var pref = data.split("~")[1];
                    if (pref) modeForHistory += "~" + pref;
                }

                var targetCategory = "MODE";
                if (modeForHistory.indexOf("IGNORELATENESS") !== -1) targetCategory = "LATENESS";
                else if (modeForHistory.indexOf("IGNOREWALK") !== -1) targetCategory = "WALK";
                else if (modeForHistory.indexOf("SKIP") !== -1 || modeForHistory.indexOf("TRIM") !== -1) targetCategory = "STATE";
                
                var coreId = baseId.split("_")[0]; 
                var routineKey = coreId + "^" + routeSig;
                var histKey = routineKey + "^" + modeForHistory;
                
                if (mem["Route_Defaults"].indexOf(histKey) === -1) {
                    var histRaw = mem["Route_History"];
                    var hParts = histRaw ? histRaw.split(",") : [];
                    var newHist = []; 
                    var count = 1;

                    for (var h = 0; h < hParts.length; h++) {
                        if (!hParts[h]) continue;
                        var hp = hParts[h].split("=");
                        var storedKey = hp[0];

                        if (storedKey.indexOf(routineKey) === 0) {
                            if (storedKey === histKey) {
                                count = parseInt(hp[1], 10) + 1;
                            } else {
                                // Check category of competing history entry
                                var curMod = storedKey.split("^").pop();
                                var curCat = "MODE";
                                if (curMod.indexOf("IGNORELATENESS") !== -1) curCat = "LATENESS";
                                else if (curMod.indexOf("IGNOREWALK") !== -1) curCat = "WALK";
                                else if (curMod.indexOf("SKIP") !== -1 || curMod.indexOf("TRIM") !== -1) curCat = "STATE";

                                // Only wipe streak if it's the SAME category but a different choice
                                if (curCat !== targetCategory) {
                                    newHist.push(hParts[h]);
                                }
                            }
                        } else {
                            newHist.push(hParts[h]);
                        }
                    }
                    
                    newHist.push(histKey + "=" + count);
                    mem["Route_History"] = newHist.join(",");

                    if (count === 3) setLocal('propose_default', histKey);
                }
            }
        }
        writeFile(filePath, JSON.stringify(mem), false);
    }
} catch(e) { flash("Appender Error: " + e.message); } 
