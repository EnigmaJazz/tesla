// ==========================================
// TDS ACTION: DEPART NOW (v1.1)
// Modifies departure time immediately and suppresses lateness alert triggers.
// ==========================================

try {
    let itinFile = "Tasker/Tesla/Data/Itin_Master.json";
    let ovFile = "Tasker/Tesla/Data/TDS_Action_Lock.json";
    let nowSec = Math.floor(Date.now() / 1000);
    
    let itinRaw = readFile(itinFile) || "[]";
    let itinerary = JSON.parse(itinRaw);

    if (itinerary.length > 0) {
        let leg = itinerary[0];
        let originalDuration = leg.durationSecs || 1800;

        leg.departUnix = nowSec;
        leg.arriveUnix = nowSec + originalDuration;
        
        leg.latenessMins = 0;
        leg.warn = "none";
        if (leg.bufferMins > 0) leg.bufferMins = 0;

        let overridePayload = {
            type: "DEPART_NOW",
            eventId: leg.targetEventId || "DEPART_NOW_ACTIVE",
            timestamp: nowSec
        };
        
        writeFile(ovFile, JSON.stringify(overridePayload), false);
        writeFile(itinFile, JSON.stringify(itinerary), false);
        
        setGlobal('Current_Status', leg.mode === "DRIVE" ? "Driving" : "Traveling");
    }
} catch(e) {
    flash("Depart Now Fault: " + e.message);
}
