// ==========================================
// AD-HOC STOP LOGGER (v2)
// Appends [EventID]_[Duration] to TDS_Completed_Stops
// (documented transient global; the Override Handler owns
// TDS_Overrides.json — RULE-8C).
// Bypasses JSON write if an "Extra" unplanned stop is selected.
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
                // E1 (RULE-8C): Completed_Stops is documented transient global
                // state, not an OVR top-level array. Stop_Logger owns the
                // TDS_Completed_Stops global; the reducer owns trip state.
                let currentStops = global('TDS_Completed_Stops') || "";
                let newStopEntry = evId + "_" + cleanStop;

                // Append to the comma-separated inventory, preventing double-logging
                if (currentStops.length > 0) {
                    if (currentStops.indexOf(newStopEntry) === -1) {
                        currentStops += "," + newStopEntry;
                    }
                } else {
                    currentStops = newStopEntry;
                }

                // Write the updated inventory to the transient global
                setGlobal('TDS_Completed_Stops', currentStops);
                // Slice C (REQ-4ADAPTER-5): stage an exact COMPLETE_STOP for
                // the Trip State Reducer — stable stopId, lastIndexOf trip
                // core, never a direct state write. The transient global above
                // remains the read-side source for components that have not
                // yet migrated to state.completedStops.
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
                        flash("Reducer rejected COMPLETE_STOP: " + r);
                    }
                }
                flash(cleanStop + "m stop marked as completed.");
            } else {
                flash("Error: Selected stop didn't contain a valid number.");
            }
        }
    } else {
        flash("Error: Missing target ID or menu selection.");
    }
} catch(e) {
    flash("Stop Logger Crash: " + e.message);
}