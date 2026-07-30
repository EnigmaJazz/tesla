// ==========================================
// TDS ACTION: DEPART NOW (v2.0)
// Command adapter — stages a publish candidate in local('par1') and
// clears the lateness halt. The next Tasker action runs
// Generation_Publisher.js. This script does NOT write Itin_Master.json
// or TDS_Master.json directly (RULE-8A).
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
    let events = (m && m.state === "committed" && m.eventsPath) ? (readJson(m.eventsPath) || []) : [];
    let master = (m && m.state === "committed" && m.masterPath) ? (readJson(m.masterPath) || []) : [];
    let itinerary = (m && m.state === "committed" && m.itineraryPath) ? (readJson(m.itineraryPath) || []) : [];

    if (itinerary.length > 0) {
        let leg = Object.assign({}, itinerary[0]);
        let originalDuration = leg.durationSecs || 1800;

        // Shift timestamps to simulate immediate departure
        leg.departUnix = nowSec;
        leg.arriveUnix = nowSec + originalDuration;

        leg.latenessMins = 0;
        leg.warn = "none";
        if (leg.bufferMins > 0) leg.bufferMins = 0;

        let updated = itinerary.slice();
        updated[0] = leg;

        setLocal("par1", JSON.stringify({ events: events, master: master, itinerary: updated }));

        // Forcefully release the engine block
        setGlobal('TDS_Lateness_Halt', 'false');

        flash("Departing now for " + (leg.targetTitle || "destination") + ".");
    }
} catch(e) {
    flash("Depart Now Fault: " + e.message);
}
