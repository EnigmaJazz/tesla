// ==========================================
// TDS ACTION: UNLOCK DISPATCHER
// Wipes the TDS_Action_Lock to resume heartbeat syncing.
// ==========================================

try {
    var lockFile = "Tasker/Tesla/Data/TDS_Action_Lock.json";
    // Simply overwrite with an empty object to resume all heartbeat/sync activity
    writeFile(lockFile, "{}", false);
    flash("Action Lock Reset. Syncing Resumed.");
} catch(e) {
    flash("Unlock Error: " + e.message);
}