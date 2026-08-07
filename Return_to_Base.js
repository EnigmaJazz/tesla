// ==========================================
// TDS RETURN TO BASE (Manual Injector v3.0)
// Command adapter — stages a typed RETURN_TO_BASE envelope for
// TDS_State_Command (REQ-4ADAPTER-4). The reducer validates the explicit
// policy and positive route metrics, records the unique manual trip, and
// stages SESSION_OPEN for the Manual Action Handler. This script does NOT
// write Itin_Master.json, TDS_Master.json, or any state file, and NEVER
// serializes or prepends a candidate itinerary leg (RULE-8A/8B, SCRIPT-15).
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Local planning-day label mirroring Sandbox_Engine/Dispatcher (reader
// convergence; Tasker scripts are standalone and cannot share functions).
function localPlanningDay(targetUnixSecs) {
    let d = new Date(targetUnixSecs * 1000);
    let y = d.getFullYear();
    let mo = ("0" + (d.getMonth() + 1)).slice(-2);
    let day = ("0" + d.getDate()).slice(-2);
    return y + "-" + mo + "-" + day;
}

try {
    let PHASE2_MANIFEST_PATH = "Tasker/Tesla/Data/TDS_Run_Manifest.json";
    let rCoords = global('TDS_Return_Coords');
    let rawMode = global('TDS_Return_Mode') || "DRIVE";
    let rName = global('TDS_Return_Name') || "Base";
    let nowSec = Math.floor(Date.now() / 1000);

    if (rCoords && rCoords.indexOf(",") !== -1) {
        let uLoc = global('User_Loc') || "0,0";
        let cLoc = global('Car_Loc') || "0,0";
        let uP = uLoc.split(",");
        let cP = rCoords.split(",");
        let carP = cLoc.split(",");

        let distM = getDist(parseFloat(uP[0]), parseFloat(uP[1]), parseFloat(cP[0]), parseFloat(cP[1]));
        let dCar = getDist(parseFloat(uP[0]), parseFloat(uP[1]), parseFloat(carP[0]), parseFloat(carP[1]));

        let rMode = rawMode.toUpperCase();
        if (rMode === "AUTO") {
            if (distM < 1500) {
                rMode = "WALK";
            } else if (dCar > 300) {
                rMode = "LIFT"; // Default fallback
                let cityZonesRaw = global('City_Transit_Zones') || "";
                if (cityZonesRaw.length > 5) {
                    let zones = cityZonesRaw.split("|");
                    for (let z = 0; z < zones.length; z++) {
                        let zC = zones[z].split(",");
                        if (getDist(parseFloat(uP[0]), parseFloat(uP[1]), parseFloat(zC[0]), parseFloat(zC[1])) <= 5000) {
                            rMode = "TRANSIT"; break;
                        }
                    }
                }
            } else {
                rMode = "DRIVE";
            }
        }

        let speed = rMode === "DRIVE" ? 13.0 : (rMode === "TRANSIT" ? 8.0 : (rMode === "LIFT" ? 10.0 : 1.4));
        let durSec = Math.round(distM / speed);
        let distMiles = parseFloat((distM * 0.000621371).toFixed(1));

        function readJson(path) {
            let raw = readFile(path) || "";
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        }

        let m = readJson(PHASE2_MANIFEST_PATH);

        // Collision-safe ids: <core>_<base36Unix> (lastIndexOf("_") convention).
        let b36 = nowSec.toString(36);
        let actionId = "action_" + b36;
        let tripId = "manual_return_" + b36;

        // Phase 6 (REQ-6STATE-2/3): status + lateness-halt observations stage
        // through the reducer so project() owns Current_Status and
        // TDS_Lateness_Halt. The primary RETURN_TO_BASE envelope is staged last
        // so the serial chain still delivers the manual-return command.
        let modeDict = { "LIFT": "Lift", "WALK": "Walking", "TRANSIT": "Public Transport", "DRIVE": "Driving" };
        setLocal('par1', 'OBSERVE_STATUS');
        setLocal('par2', JSON.stringify({
            generationId: global('TDS_Active_Generation') || (m && m.activeGeneration) || null,
            status: (modeDict[rMode] || "Traveling") + " (Heading Home)",
            at: nowSec
        }));
        setLocal('par1', 'OBSERVE_LATENESS_HALT');
        setLocal('par2', JSON.stringify({
            generationId: global('TDS_Active_Generation') || (m && m.activeGeneration) || null,
            halt: false,
            at: nowSec
        }));

        setLocal('par1', 'RETURN_TO_BASE');
        setLocal('par2', JSON.stringify({
            generationId: global('TDS_Active_Generation') || (m && m.activeGeneration) || null,
            actionId: actionId,
            tripId: tripId,
            at: nowSec,
            policy: "MANUAL",
            originCoords: uLoc,
            targetCoords: rCoords,
            targetTitle: "Return to " + rName,
            mode: rMode,
            durationSecs: durSec,
            distanceMiles: distMiles,
            planningDay: localPlanningDay(nowSec)
        }));

        flash("Return to " + rName + " via " + modeDict[rMode] + " queued.");
    }
} catch(e) {
    flash("Return to Base Error: " + e.message);
}
