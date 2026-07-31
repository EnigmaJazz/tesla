// ==========================================
// AD-HOC STOP LOGGER (v2)
// Appends [EventID]_[Duration] to Completed_Stops in TDS_Overrides
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
                let ovrFile = "Tasker/Tesla/Data/TDS_Overrides.json";
                let ovrRaw = readFile(ovrFile) || "{}";
                let OVR = JSON.parse(ovrRaw);

                let currentStops = OVR['Completed_Stops'] || "";
                let newStopEntry = evId + "_" + cleanStop;

                // Append to the comma-separated inventory, preventing double-logging
                if (currentStops.length > 0) {
                    if (currentStops.indexOf(newStopEntry) === -1) {
                        currentStops += "," + newStopEntry;
                    }
                } else {
                    currentStops = newStopEntry;
                }

                // Write the updated inventory back to disk
                OVR['Completed_Stops'] = currentStops;
                writeFile(ovrFile, JSON.stringify(OVR), false);
                // Phase 3 PR-C: stage COMPLETE_STOP for the Trip State Reducer.
                // The legacy Completed_Stops OVR write above remains as a read-side
                // shim for components that have not yet been migrated to state.completedStops.
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