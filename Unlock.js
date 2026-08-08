// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";

// ==========================================
// TDS ACTION: UNLOCK DISPATCHER — command adapter (REQ-4ADAPTER-6).
// Reads the ACTIVE session (sessions primary) and stages exact RELEASE
// {actionId,tripId,at} when reducer completion is recorded, or SESSION_CLOSE
// {actionId,at} otherwise. Never writes the lock or state (REQ-4SESSION-2,
// SCRIPT-15).
// ==========================================

try {
    let nowSec = Math.floor(Date.now() / 1000);
    let activeSession = null;
    try {
        let sRaw = readFile(DATA_ROOT + "TDS_Action_Sessions.json") || "";
        if (sRaw) {
            let sObj = JSON.parse(sRaw);
            if (sObj && sObj.sessions) {
                let keys = Object.keys(sObj.sessions);
                for (let i = 0; i < keys.length && !activeSession; i++) {
                    if (sObj.sessions[keys[i]].status === "ACTIVE") activeSession = sObj.sessions[keys[i]];
                }
            }
        }
    } catch(e) { activeSession = null; }

    if (activeSession) {
        let completionSeen = false;
        try {
            let stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
            if (stRaw) completionSeen = (JSON.parse(stRaw).manualReturnCompleted === true);
        } catch(e) { completionSeen = false; }

        if (completionSeen) {
            setLocal('par1', 'RELEASE');
            setLocal('par2', JSON.stringify({
                actionId: activeSession.actionId,
                tripId: activeSession.tripId,
                at: nowSec
            }));
        } else {
            setLocal('par1', 'SESSION_CLOSE');
            setLocal('par2', JSON.stringify({
                actionId: activeSession.actionId,
                at: nowSec
            }));
        }
    }
} catch(e) {
    flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
        component: "Unlock", severity: "ERROR", code: "UNLOCK_ADAPTER_ERROR", tripId: null, details: { message: e.message } }));
}
