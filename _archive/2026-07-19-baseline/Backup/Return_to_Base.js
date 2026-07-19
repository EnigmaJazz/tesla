// ==========================================
// TDS RETURN TO BASE (Manual Injector v1.1)
// Fully migrated to Tasker/Tesla/Data/ directory structure.
// Engages TDS_Action_Lock to suppress Heartbeat during manual routing.
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

try {
    let rCoords = global('TDS_Return_Coords');
    let rMode = global('TDS_Return_Mode') || "DRIVE";
    let rName = global('TDS_Return_Name') || "Base";
    let nowSec = Math.floor(Date.now() / 1000);

    if (rCoords && rCoords.indexOf(",") !== -1) {
        let uLoc = global('User_Loc') || "0,0";
        let uP = uLoc.split(",");
        let cP = rCoords.split(",");
        
        let distM = getDist(parseFloat(uP[0]), parseFloat(uP[1]), parseFloat(cP[0]), parseFloat(cP[1]));
        let speed = rMode === "DRIVE" ? 13.0 : (rMode === "TRANSIT" ? 8.0 : 1.4);
        let durSec = Math.round(distM / speed);
        let distMiles = parseFloat((distM * 0.000621371).toFixed(1));

        // 1. Target correct file paths
        let itinFile = "Tasker/Tesla/Data/Itin_Master.json";
        let lockFile = "Tasker/Tesla/Data/TDS_Action_Lock.json";
        
        let itinRaw = "";
        try { itinRaw = readFile(itinFile) || "[]"; } catch(e) { itinRaw = "[]"; }
        let itinerary = [];
        try { itinerary = JSON.parse(itinRaw); } catch(e) {}

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
            pitstopState: "false",
            latenessMins: 0,
            bufferMins: 0,
            transitStepsRaw: rMode === "DRIVE" ? "🚗 Route securely managed by vehicle onboard navigation" : ""
        };

        // 2. Inject to front for immediate execution
        itinerary.unshift(returnLeg);
        writeFile(itinFile, JSON.stringify(itinerary), false);

        // 3. Engage Lock File so Dispatcher ignores fast-sync
        let lockPayload = {
            type: "MANUAL_ROUTING",
            timestamp: nowSec
        };
        writeFile(lockFile, JSON.stringify(lockPayload), false);

        setGlobal('Current_Status', rMode === "DRIVE" ? "Driving" : "Traveling");
        flash("Return to " + rName + " engaged. Heartbeat suppressed.");
    }
} catch(e) {
    flash("Return to Base Error: " + e.message);
}