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
        let genId = global('TDS_Active_Generation') || (m && m.activeGeneration) || null;

        // FU1 (REQ-6FU-4, SCN-6FU-8): the halt release and the primary
        // DEPART_NOW are staged as ONE REDUCER_BATCH envelope with DEPART_NOW
        // LAST inside the batch. The serial Tasker model delivers only the
        // final par1/par2, so the batch carries both observations to the
        // router; the primary-last contract is preserved semantically (the
        // primary is the last sub-command the reducer applies) and the halt
        // observation is no longer sacrificed. project() owns the global
        // (REQ-6STATE-2/3).
        setLocal('par1', 'REDUCER_BATCH');
        setLocal('par2', JSON.stringify({
            generationId: genId,
            commands: [
                { command: 'OBSERVE_LATENESS_HALT', payload: { generationId: genId, halt: false, at: nowSec } },
                { command: 'DEPART_NOW', payload: { generationId: genId, tripId: tripId, at: nowSec } }
            ]
        }));

        flash("Departing now for " + (leg.targetTitle || "destination") + ".");
    }
} catch(e) {
    flash("Depart Now Fault: " + e.message);
}
