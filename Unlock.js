// ==========================================
// TDS ACTION: UNLOCK DISPATCHER
// Wipes the TDS_Action_Lock to resume heartbeat syncing.
// Slice B (AC-5/0E/B3): the lock is cleared only after a successful
// reducer COMPLETE_TRIP (manualReturnCompleted=true in
// TDS_Trip_State.json). Without that explicit signal the lock survives,
// and no TDS_Action_Sessions.json file is ever written.
// ==========================================

try {
    var lockFile = "Tasker/Tesla/Data/TDS_Action_Lock.json";
    var completionSeen = false;
    try {
        var stRaw = readFile("Tasker/Tesla/Data/TDS_Trip_State.json") || "";
        if (stRaw) completionSeen = (JSON.parse(stRaw).manualReturnCompleted === true);
    } catch(e) { completionSeen = false; }

    if (completionSeen) {
        writeFile(lockFile, "{}", false);
        flash("Action Lock Reset. Syncing Resumed.");
    } else {
        flash("Action Lock Kept: reducer completion not recorded.");
    }
} catch(e) {
    flash("Unlock Error: " + e.message);
}
