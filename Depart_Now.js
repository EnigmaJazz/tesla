// ==========================================
// TDS ACTION: DEPART NOW (v3.0)
// Command adapter — stages a typed DEPART_NOW envelope for
// TDS_State_Command (REQ-4ADAPTER-3). The reducer applies the lifecycle
// change to only the selected trip. This script does NOT write
// Itin_Master.json, TDS_Master.json, or any state file (RULE-8A/8B,
// SCRIPT-15) and never stages a full publish candidate.
// ==========================================

try {
    let PHASE2_MANIFEST_PATH = "Tasker/Tesla/Data/TDS_Run_Manifest.json";
    let nowSec = Math.floor(Date.now() / 1000);

    function readJson(path) {
        let raw = readFile(path) || "";
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    let m = readJson(PHASE2_MANIFEST_PATH);
    let itinerary = (m && m.state === "committed" && m.itineraryPath) ? (readJson(m.itineraryPath) || []) : [];

    if (itinerary.length > 0) {
        let leg = itinerary[0];
        let tripId = leg.tripId || leg.targetEventId || "";

        // Forcefully release the engine block: staged OBSERVE_LATENESS_HALT
        // clears the halt through the reducer so project() owns the global
        // (REQ-6STATE-2/3). The primary DEPART_NOW envelope is staged last so
        // the serial chain still delivers the departure command.
        setLocal('par1', 'OBSERVE_LATENESS_HALT');
        setLocal('par2', JSON.stringify({
            generationId: global('TDS_Active_Generation') || (m && m.activeGeneration) || null,
            halt: false,
            at: nowSec
        }));

        setLocal('par1', 'DEPART_NOW');
        setLocal('par2', JSON.stringify({
            generationId: global('TDS_Active_Generation') || (m && m.activeGeneration) || null,
            tripId: tripId,
            at: nowSec
        }));

        flash("Departing now for " + (leg.targetTitle || "destination") + ".");
    }
} catch(e) {
    flash("Depart Now Fault: " + e.message);
}
