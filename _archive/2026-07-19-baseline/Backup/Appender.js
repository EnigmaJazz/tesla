// ==========================================
// UNIVERSAL APPENDER (V10.0)
// Fully migrated to Tasker/Tesla/Data/ directory structure.
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

        // --- SINGLE FILE I/O LOAD ---
        var filePath = "Tasker/Tesla/Data/TDS_Overrides.json";
        var rawFile = readFile(filePath) || "{}";
        var mem = {};
        try { mem = JSON.parse(rawFile); } catch(e) {}
        
        for (var i = 0; i < allArrays.length; i++) {
            if (!mem[allArrays[i]]) mem[allArrays[i]] = "";
        }

        if (targetArray !== "") {
            for (var i = 0; i < allArrays.length - 2; i++) { 
                var arrName = allArrays[i];
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

            if (routeSig !== "" && (rawCmd === "LIFT" || rawCmd === "TRANSIT" || rawCmd === "WALK" || rawCmd === "DRIVE")) {
                var coreId = baseId.split("_")[0]; 
                var routineKey = coreId + "^" + routeSig;
                var histKey = routineKey + "^" + rawCmd;
                
                if (mem["Route_Defaults"].indexOf(routineKey) === -1) {
                    var histRaw = mem["Route_History"];
                    var hParts = histRaw ? histRaw.split(",") : [];
                    var newHist = []; 
                    var count = 1;

                    for (var h = 0; h < hParts.length; h++) {
                        if (!hParts[h]) continue;
                        var hp = hParts[h].split("=");
                        var storedKey = hp[0];

                        if (storedKey.indexOf(routineKey) === 0) {
                            if (storedKey === histKey) count = parseInt(hp[1], 10) + 1;
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
