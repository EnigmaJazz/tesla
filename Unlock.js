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
        let sRaw = readFile("Tasker/Tesla/Data/TDS_Action_Sessions.json") || "";
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
            let stRaw = readFile("Tasker/Tesla/Data/TDS_Trip_State.json") || "";
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
    flash("Unlock Error: " + e.message);
}
