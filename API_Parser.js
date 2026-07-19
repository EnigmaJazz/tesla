// ==========================================
// API RESULT PARSER (TCS-7 V12.7)
// Extracts optimizedWaypoint routing for Cluster arrays.
// [V12.7] Safe array insertion and null-safe transit time parsing.
// ==========================================

(function() {
    function forceSeconds(val) {
        let v = parseFloat(val); 
        if (isNaN(v) || v < 0) return 0; 
        return Math.floor(v); 
    }

    // [SURGICAL UPGRADE: In-Place Sorting]
    function sortMasterJson(orderedIdsStr) {
        let orderedIds = orderedIdsStr.split(",");
        let masterRaw = readFile("Tasker/Tesla/Data/TDS_Master.json") || "[]";
        let masterArr = JSON.parse(masterRaw);
        
        let targetIndices = [];
        let clusterMap = {};
        for(let i = 0; i < masterArr.length; i++) {
            if (orderedIds.indexOf(masterArr[i].id) !== -1) {
                targetIndices.push(i);
                clusterMap[masterArr[i].id] = masterArr[i];
            }
        }
        for(let j = 0; j < orderedIds.length; j++) {
            if (targetIndices[j] !== undefined && clusterMap[orderedIds[j]]) {
                masterArr[targetIndices[j]] = clusterMap[orderedIds[j]];
            }
        }
        writeFile("Tasker/Tesla/Data/TDS_Master.json", JSON.stringify(masterArr), false);
    }

    try {
        let rawPayload = readFile("Tasker/Tesla/Data/temp_payload.json");
        if (!rawPayload || rawPayload.indexOf("{") === -1) throw new Error("Missing or empty disk staging payload.");

        let res = JSON.parse(rawPayload);
        
        if (local('api_route_mode') === "CLUSTER") {
            let clusterRaw = local('par1');
            let cluster = JSON.parse(clusterRaw);
            let uLoc = global('User_Loc') || "0,0";
            let wpIdStr = cluster.waypoints.map(function(w){ return w.id; }).join(",");

            let orderedIds = [];
            
            if (res.routes && res.routes.length > 0 && res.routes[0].optimizedIntermediateWaypointIndex) {
                let optIndexes = res.routes[0].optimizedIntermediateWaypointIndex;
                for (let x = 0; x < optIndexes.length; x++) orderedIds.push(cluster.waypoints[optIndexes[x]].id);
            } else {
                for (let k = 0; k < cluster.waypoints.length; k++) orderedIds.push(cluster.waypoints[k].id);
            }
            
            let finalOrderStr = orderedIds.join(",");
            let cacheLine = uLoc + "|" + cluster.destination.id + "|" + wpIdStr + "|" + finalOrderStr;
            let orderCacheRaw = ""; try { orderCacheRaw = readFile("Tasker/Tesla/Data/TDS_Order_Cache.txt") || ""; } catch(e){}
            writeFile("Tasker/Tesla/Data/TDS_Order_Cache.txt", orderCacheRaw ? (orderCacheRaw + "\n" + cacheLine) : cacheLine, false);
            
            sortMasterJson(finalOrderStr);
            writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);
            return;
        }

        let dur = 0; let distM = 0; let stepsStr = "";
        
        if (res.routes && res.routes.length > 0) {
            let route = res.routes[0];
            let leg = (route.legs && route.legs.length > 0) ? route.legs[0] : {};

            let rawDurStr = String(route.duration || leg.staticDuration || "0s");
            dur = parseInt(rawDurStr.replace('s', ''), 10); 
            distM = parseInt(route.distanceMeters || leg.distanceMeters || 0, 10);
            
            if (local('api_route_mode') === "TRANSIT" && leg.steps && leg.steps.length > 0) {
                let steps = leg.steps;
                for (let s = 0; s < steps.length; s++) {
                    if (steps[s].transitDetails) {
                        let td = steps[s].transitDetails;
                        // [SURGICAL UPGRADE: Null-safe Transit Parsing]
                        let dt = td.stopDetails.departureTime ? new Date(td.stopDetails.departureTime) : new Date();
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
        
        if (isNaN(dur) || dur < 0 || isNaN(distM) || distM < 0 || distM > 5000000) {
            flash("⚠️ API Parser Fault: Invalid metrics.");
            let mockFallback = JSON.stringify({ durationSecs: 0, distanceMeters: 0, distanceMiles: "0", transitSteps: "" });
            setLocal('api_return_json', mockFallback);
            writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);
            return; 
        }

        let resultObj = { durationSecs: dur, distanceMeters: distM, distanceMiles: (distM / 1609.34).toFixed(1), transitSteps: stepsStr.length > 0 ? ("\n" + stepsStr) : "" };
        setLocal('api_return_json', JSON.stringify(resultObj));
        
        let cacheFile = "Tasker/Tesla/Data/Temp_Route_Cache.txt";
        let tRaw = ""; try { tRaw = readFile(cacheFile) || ""; } catch(e) {}

        let nowSec = Math.floor(Date.now() / 1000);
        let targetSec = forceSeconds(local('par14')) || nowSec;
        let origParam = (local('par11') || "").trim(); let destParam = (local('par12') || "").trim(); let modeParam = (local('par13') || "DRIVE").trim().toUpperCase();

        if (origParam && destParam) {
            let newEntry = origParam + "~" + destParam + "~" + modeParam + "~" + dur + "~" + distM + "~" + nowSec + "~" + targetSec;
            writeFile(cacheFile, tRaw ? (tRaw + "|" + newEntry) : newEntry, false);
        }

        writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);

    } catch(e) {
        flash("API Result Parser Exception. \n" + e.message);
        let mockFallback = JSON.stringify({ durationSecs: 0, distanceMeters: 0, distanceMiles: "0", transitSteps: "" });
        setLocal('api_return_json', mockFallback);
        try { writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false); } catch(err){}
        return; 
    }
})();
