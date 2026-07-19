// ==========================================
// API RESULT PARSER (TCS-7 V12.4 - FILE TEMP CACHE)
// Encapsulated to prevent sandbox leaks.
// Writes API outputs natively to the Temp Cache flat file.
// FIXED: Allows 0-values for proxy routing and casts strings safely.
// ==========================================

(function() {
    function forceSeconds(val) {
        let v = parseFloat(val); 
        // Changed to < 0 so we don't reject 0-second proxies
        if (isNaN(v) || v < 0) return 0; 
        return Math.floor(v); 
    }

    try {
        let rawPayload = readFile("Tasker/Tesla/Data/temp_payload.json");
        if (!rawPayload || rawPayload.indexOf("{") === -1) {
            throw new Error("Missing or empty disk staging payload.");
        }

        let res = JSON.parse(rawPayload);
        let dur = 0; 
        let distM = 0; 
        let stepsStr = "";
        
        if (res.routes && res.routes.length > 0) {
            let route = res.routes[0];
            let leg = (route.legs && route.legs.length > 0) ? route.legs[0] : {};

            // String() cast prevents TypeError if Google returns raw integers
            let rawDurStr = String(route.duration || leg.staticDuration || "0s");
            dur = parseInt(rawDurStr.replace('s', ''), 10); 
            distM = parseInt(route.distanceMeters || leg.distanceMeters || 0, 10);
            
            if (local('api_route_mode') === "TRANSIT" && leg.steps && leg.steps.length > 0) {
                let steps = leg.steps;
                for (let s = 0; s < steps.length; s++) {
                    if (steps[s].transitDetails) {
                        let td = steps[s].transitDetails;
                        let dt = new Date(td.stopDetails.departureTime);
                        let hrs = ("0" + dt.getHours()).slice(-2);
                        let mins = ("0" + dt.getMinutes()).slice(-2);
                        let lineName = td.transitLine.nameShort || td.transitLine.name || "Transit";
                        let stopName = td.stopDetails.arrivalStop ? td.stopDetails.arrivalStop.name : "Destination";
                        
                        stepsStr += "  • [" + hrs + ":" + mins + "] " + lineName + " to " + stopName + "\n";
                    } else if (steps[s].navigationInstruction && steps[s].navigationInstruction.instructions) {
                        stepsStr += "  • (Walk) " + steps[s].navigationInstruction.instructions + "\n";
                    }
                }
            }
        }
        
        // Changed <= 0 to < 0 to allow valid 0-meter/0-second trips
        if (isNaN(dur) || dur < 0 || isNaN(distM) || distM < 0 || distM > 5000000) {
            flash("⚠️ API Parser Fault: Invalid metrics. Aborting write to cache.");
            let mockFallback = JSON.stringify({ durationSecs: 0, distanceMeters: 0, distanceMiles: "0", transitSteps: "" });
            setLocal('api_return_json', mockFallback);
            
            // Still wipe payload even on failure to prevent cross-contamination
            writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);
            return; 
        }

        let resultObj = { 
            durationSecs: dur, 
            distanceMeters: distM, 
            distanceMiles: (distM / 1609.34).toFixed(1), 
            transitSteps: stepsStr.length > 0 ? ("\n" + stepsStr) : "" 
        };
        setLocal('api_return_json', JSON.stringify(resultObj));
        
        // Read & Append to Text File directly
        let cacheFile = "Tasker/Tesla/Data/Temp_Route_Cache.txt";
        let tRaw = "";
        try { tRaw = readFile(cacheFile) || ""; } catch(e) {}

        let nowSec    = Math.floor(Date.now() / 1000);
        let targetSec = forceSeconds(local('par14')) || nowSec;

        let origParam = (local('par11') || "").trim();
        let destParam = (local('par12') || "").trim();
        let modeParam = (local('par13') || "DRIVE").trim().toUpperCase();

        if (origParam && destParam) {
            let newEntry = origParam + "~" + destParam + "~" + modeParam + "~" + dur + "~" + distM + "~" + nowSec + "~" + targetSec;
            writeFile(cacheFile, tRaw ? (tRaw + "|" + newEntry) : newEntry, false);
        }

        // Wipe payload to prevent cross-contamination on next run
        writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);

    } catch(e) {
        flash("API Result Parser Exception. Committing mock fallback.");
        let mockFallback = JSON.stringify({ durationSecs: 0, distanceMeters: 0, distanceMiles: "0", transitSteps: "" });
        setLocal('api_return_json', mockFallback);
        try { writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false); } catch(err){}
        return; 
    }
})();
