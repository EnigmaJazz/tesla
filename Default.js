// ==========================================
// TDS DEFAULT MANAGER (v1.3 Smart Categorization)
// Unified script to Set or Wipe Defaults in JSON.
// Separates Mode, Lateness, and Walk histories so they don't wipe each other.
// ==========================================

try {
    var fullCmd = local('command_text') || local('par1') || "";
    var isSet = fullCmd.indexOf("TDS_SET_DEFAULT") !== -1;
    
    // Clean all command prefixes off the target key
    var targetKey = fullCmd.replace("TDS_SET_DEFAULT|", "").replace("TDS_CLEAR_DEFAULT|", "").replace("CLEAR_DEFAULT|", "").trim();

    // D1 (RULE-8C): The Override Handler owns TDS_Overrides.json. Default
    // stages a SET_DEFAULT command; the handler applies the categorized
    // set/wipe, clears matching history, and exports cancel_id.
    const clearAll = targetKey.toUpperCase() === "ALL";

    setLocal('par1', 'SET_DEFAULT');
    setLocal('par2', JSON.stringify({ targetKey: targetKey, isSet: isSet, clearAll: clearAll }));

} catch(e) { flash("Default Manager Error: " + e.message); }
