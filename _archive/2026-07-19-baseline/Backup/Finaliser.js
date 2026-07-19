// ==========================================
// SCRIPT 3: ENGINE FINALISER (v24.2)
// Integrates manual override lock logic to protect dynamic legs.
// Fully migrated to Tasker/Tesla/Data/ structure.
// ==========================================

try {
    let tempRaw = local('tds_temp_json') || "[]";
    if (tempRaw.indexOf("%") === 0) tempRaw = "[]";
    let validEvents = JSON.parse(tempRaw);

    let diskRaw = readFile("Tasker/Tesla/Data/Geocode_Cache.json");
    let diskLower = {};
    if (diskRaw && diskRaw.indexOf("%") === -1) {
        try {
            let rawJson = JSON.parse(diskRaw);
            for (let dKey in rawJson) {
                if (rawJson.hasOwnProperty(dKey)) diskLower[dKey.trim().toLowerCase()] = rawJson[dKey];
            }
        } catch(e) {}
    }

    let nextGeoCoords = "NONE";
    let nextGeoTitle  = "NONE";
    let nowSec = Math.floor(Date.now() / 1000);

    for (let i = 0; i < validEvents.length; i++) {
        let ev = validEvents[i];
        let cleanLoc = (ev.loc || "").trim().toLowerCase();
        
        if (diskLower[cleanLoc]) {
            ev.coords = diskLower[cleanLoc];
        }

        if (nextGeoCoords === "NONE" && ev.coords !== "0,0" && ev.end > nowSec) {
            nextGeoCoords = ev.coords.replace(",", "~");
            nextGeoTitle  = (ev.title || "Meeting").replace(/[^a-zA-Z0-9 ]/g, "").trim();
        }
    }

    let baseStr = local('raw_base_data') || "";
    let finalBaseStr = "";
    
    if (baseStr && baseStr.indexOf("%") === -1 && baseStr.length > 3) {
        let bases = baseStr.split("|");
        for (let b = 0; b < bases.length; b++) {
            let parts = bases[b].split("~");
            let bLocClean = (parts[5] || "").trim().toLowerCase();
            if (diskLower[bLocClean]) {
                parts[2] = diskLower[bLocClean];
            }
            finalBaseStr += (finalBaseStr.length > 0 ? "|" : "") + parts.join("~");
        }
    }

    let adHoc = global('AdHoc_Base') || "";
    if (adHoc.indexOf("%") !== 0 && adHoc.length > 5) finalBaseStr += (finalBaseStr.length > 0 ? "|" : "") + adHoc;

    writeFile("Tasker/Tesla/Data/TDS_Master.json", JSON.stringify(validEvents), false);

    let baseFilePath = "Tasker/Tesla/Data/TDS_Base_Geocodes.txt";
    let oldBaseStr = "";
    try { oldBaseStr = readFile(baseFilePath) || ""; } catch(e) {}

    if (finalBaseStr !== oldBaseStr) {
        writeFile(baseFilePath, finalBaseStr, false);
    }

    setLocal('next_geo_coords', nextGeoCoords);
    setLocal('next_geo_title', nextGeoTitle);
    
    // ==========================================
    // OVERRIDE PROTECTION MERGE
    // ==========================================
    let overrideFile = "Tasker/Tesla/Data/TDS_Action_Lock.json";
    let activeOverride = null;

    try {
        let ovRaw = readFile(overrideFile) || "{}";
        activeOverride = JSON.parse(ovRaw);
    } catch(e) { activeOverride = null; }

    if (activeOverride && activeOverride.type) {
        if (nowSec - activeOverride.timestamp < 7200) {
            let newItinStr = global('Engine_Output_Itinerary') || "[]"; 
            let newItin = JSON.parse(newItinStr);
            
            let currentMasterRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
            let currentMaster = JSON.parse(currentMasterRaw);
            
            if (currentMaster.length > 0 && currentMaster[0].targetEventId === activeOverride.eventId) {
                newItin.unshift(currentMaster[0]); 
                setGlobal('Engine_Output_Itinerary', JSON.stringify(newItin));
            }
        } else {
            writeFile(overrideFile, "{}", false);
        }
    }

    setLocal('tds_temp_json', "");
    setLocal('raw_base_data', "");

} catch(err) { flash("Finalizer JS Crash: " + err.message); }
