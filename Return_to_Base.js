// ==========================================
// TDS RETURN TO BASE (Manual Injector v2.0)
// Command adapter — stages a publish candidate in local('par1') and
// clears the lateness halt. The next Tasker action runs
// Generation_Publisher.js. This script does NOT write Itin_Master.json
// or TDS_Master.json directly (RULE-8A).
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
                // Car is not here. Determine if we can use Transit based on city zones.
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
        let events = (m && m.state === "committed" && m.eventsPath) ? (readJson(m.eventsPath) || []) : [];
        let master = (m && m.state === "committed" && m.masterPath) ? (readJson(m.masterPath) || []) : [];
        let itinerary = (m && m.state === "committed" && m.itineraryPath) ? (readJson(m.itineraryPath) || []) : [];

        let returnLeg = {
            targetEventId: "MANUAL_RETURN",
            targetTitle: "Return to " + rName,
            targetDesc: "Manual return initiated from dashboard.",
            targetCoords: rCoords,
            mode: rMode,
            departUnix: nowSec,
            arriveUnix: nowSec + durSec,
            durationSecs: durSec,
            distanceMiles: distMiles,
            pitstopState: "end_of_day",
            latenessMins: 0,
            bufferMins: 0,
            transitStepsRaw: rMode === "DRIVE" ? "🚗 Route securely managed by vehicle onboard navigation" : ""
        };

        let updated = itinerary.slice();
        updated.unshift(returnLeg);
        setLocal("par1", JSON.stringify({ events: events, master: master, itinerary: updated }));

        let modeDict = { "LIFT": "Lift", "WALK": "Walking", "TRANSIT": "Public Transport", "DRIVE": "Driving" };
        setGlobal('Current_Status', (modeDict[rMode] || "Traveling") + " (Heading Home)");
        setGlobal('TDS_Lateness_Halt', 'false'); // Clear any pending locks

        flash("Return to " + rName + " via " + modeDict[rMode] + " queued.");
    }
} catch(e) {
    flash("Return to Base Error: " + e.message);
}
