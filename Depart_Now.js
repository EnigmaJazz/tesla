// ==========================================
// TDS ACTION: DEPART NOW (v1.2)
// Modifies departure time immediately and suppresses lateness alert triggers.
// [V1.2] Force-clears lateness halts. Applies exact UI Status suffixes.
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

        // Shift timestamps to simulate immediate departure
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
        
        // Resolve exact UI string for Dashboard
        let modeDict = { "LIFT": "Lift", "WALK": "Walking", "TRANSIT": "Public Transport", "DRIVE": "Driving", "EOD_RETURN": "Driving" };
        let baseStatus = modeDict[leg.mode] || "Traveling";
        
        let pitStr = "";
        if (leg.pitstopState === 'true' || leg.pitstopState === 'forced' || leg.pitstopState === 'handled') {
            pitStr = " (Pitstop)";
        } else if (leg.pitstopState === 'end_of_day') {
            pitStr = " (Heading Home)";
        }
        
        setGlobal('Current_Status', baseStatus + pitStr);
        
        // Forcefully release the engine block
        setGlobal('TDS_Lateness_Halt', 'false');
        
        flash("Departing now for " + (leg.targetTitle || "destination") + ".");
    }
} catch(e) {
    flash("Depart Now Fault: " + e.message);
}
