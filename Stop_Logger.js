// ==========================================
// AD-HOC STOP LOGGER (v2)
// Stages an exact COMPLETE_STOP command for the Trip State Reducer, which
// records the stop in state.completedStops (trip-state-only — REQ-6STATE-1).
// The legacy TDS_Completed_Stops global is no longer read or written.
// Bypasses the command if an "Extra" unplanned stop is selected.
// ==========================================

try {
    // Retrieve variables from Tasker
    let evId = local('active_target_id');
    let selStop = local('ld_selected') || ""; 

    if (evId && selStop) {
        
        // 1. Check if the user selected the "Extra / Unplanned" option
        if (/(extra|unplanned|other)/i.test(selStop)) {
            // Do not alter the JSON. The physical time elapsed will handle the ETA delay.
            flash("Extra stop noted. Planned stops remain pending.");
        } 
        // 2. Process a planned stop
        else {
            // Strip out any text (like "m") leaving only the raw number
            let cleanStop = selStop.replace(/[^0-9]/g, ""); 
            
            if (cleanStop.length > 0) {
                // Phase 6 (REQ-6STATE-1): completed stops are trip-state-only.
                // The COMPLETE_STOP command staged below is the sole record
                // path — the reducer owns state.completedStops. No global
                // read or write of TDS_Completed_Stops remains.
                let newStopEntry = evId + "_" + cleanStop;

                // Slice C (REQ-4ADAPTER-5): stage an exact COMPLETE_STOP for
                // the Trip State Reducer — stable stopId, lastIndexOf trip
                // core, never a direct state write.
                let stopId = newStopEntry;
                let tripId = evId.substring(0, evId.lastIndexOf("_"));
                setLocal("par1", "COMPLETE_STOP");
                setLocal("par2", JSON.stringify({
                    generationId: global("TDS_Active_Generation") || "gen:0:0000",
                    stopId: stopId,
                    tripId: tripId,
                    at: Math.floor(Date.now() / 1000)
                }));
                if (typeof reducer === "function") {
                    let r = reducer("COMPLETE_STOP", JSON.parse(local("par2")));
                    if (typeof r === "string" && r.indexOf("OK") !== 0) {
                        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
                            component: "Stop_Logger", severity: "ERROR", code: "COMPLETE_STOP_REJECTED", tripId: tripId, details: { reason: r } }));
                    }
                }
                flash(cleanStop + "m stop marked as completed.");
            } else {
                flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
                    component: "Stop_Logger", severity: "ERROR", code: "STOP_DURATION_INVALID", tripId: evId || null, details: { reason: "selected stop did not contain a valid number", selected: selStop } }));
            }
        }
    } else {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Stop_Logger", severity: "ERROR", code: "STOP_TARGET_MISSING", tripId: null, details: { reason: "missing target id or menu selection", evId: evId || null, selStop: selStop || null } }));
    }
} catch(e) {
    flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
        component: "Stop_Logger", severity: "ERROR", code: "STOP_LOGGER_CRASH", tripId: null, details: { message: e.message } }));
}