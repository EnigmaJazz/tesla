// ==========================================
// PRE-API PAYLOAD BUILDER (Hardened V4.1)
// Parses JSON straight from %par1 for clusters.
// ==========================================

// Named constants (AGENTS.md: no magic numbers).
const EPOCH_MS_THRESHOLD = 20000000000; // inputNum > this => epoch ms, else seconds
const ORIGIN_FALLBACK_COORDS = "0,0";   // degraded-invocation origin fallback
const REQ_ID_HEX_RANGE = 0x10000;       // request-id random hex range
const REQ_ID_HEX_PAD = "0000";          // request-id hex left-pad
const REQ_ID_HEX_LEN = 4;               // request-id hex width

function getCoord(rawStr, splitIndex) {
    if (!rawStr || rawStr.indexOf("%") === 0) return 0.0;
    const parts = rawStr.split(",");
    const val = parseFloat(parts[splitIndex]);
    return isNaN(val) ? 0.0 : val;
}

// Phase 5 Slice C (REQ-5REQID-1): stamp a correlation envelope for the active
// generation and register the latest request with the Route Cache Manager
// BEFORE the wire body is sent. The envelope is staged into api_correlation
// (and par1/par2 as REQUEST_STATE_REGISTER for the manager); the Google Routes
// wire payload NEVER carries generationId/clusterId/requestId.
function rqRegisterCorrelation(clusterId) {
    const rqNow = Math.floor(Date.now() / 1000);
    const rqHex = (REQ_ID_HEX_PAD + Math.floor(Math.random() * REQ_ID_HEX_RANGE).toString(16)).slice(-REQ_ID_HEX_LEN);
    const rqRequestId = "req:" + rqNow + ":" + rqHex;
    const rqGenerationId = global('TDS_Active_Generation') || null;
    setLocal('api_correlation', JSON.stringify({ generationId: rqGenerationId, clusterId: clusterId, requestId: rqRequestId }));
    setLocal('par1', 'REQUEST_STATE_REGISTER');
    setLocal('par2', JSON.stringify({ generationId: rqGenerationId, clusterId: clusterId, requestId: rqRequestId, emittedAt: rqNow }));
}

try {
    const rawPar1 = local('par1') || "";
    
    // --- CLUSTER FORK ---
    if (rawPar1.indexOf("{") === 0) {
        const cluster = JSON.parse(rawPar1);
        
        const uLoc = (cluster.origin) || global('User_Loc') || ORIGIN_FALLBACK_COORDS;
        const body = {
            "origin": { "location": { "latLng": { "latitude": getCoord(uLoc, 0), "longitude": getCoord(uLoc, 1) } } },
            "destination": { "location": { "latLng": { "latitude": parseFloat(cluster.destination.coords.split(",")[0]), "longitude": parseFloat(cluster.destination.coords.split(",")[1]) } } },
            "travelMode": "DRIVE",
            "optimizeWaypointOrder": true, 
            "intermediates": []
        };
        
        const rqWpIds = [];
        for (let w = 0; w < cluster.waypoints.length; w++) {
            const wC = cluster.waypoints[w].coords.split(",");
            rqWpIds.push(cluster.waypoints[w].id);
            body.intermediates.push({
                "location": { "latLng": { "latitude": parseFloat(wC[0]), "longitude": parseFloat(wC[1]) } }
            });
        }
        
        rqRegisterCorrelation(uLoc + "|" + cluster.destination.id + "|" + rqWpIds.join(","));
        setLocal('api_cluster_json', JSON.stringify(cluster));
        setLocal('api_request_body', JSON.stringify(body)); 
        setLocal('api_route_mode', "CLUSTER");
        
    } else {
        // --- STANDARD A-TO-B FORK ---
        const rawMode = local('par13') || "DRIVE";
        const routeMode = (rawMode === "TRANSIT") ? "TRANSIT" : ((rawMode === "WALK") ? "WALK" : "DRIVE");

        let targetMs = Date.now();
        const inputNum = parseFloat(local('par14'));
        if (!isNaN(inputNum) && inputNum > 0) targetMs = (inputNum < EPOCH_MS_THRESHOLD) ? Math.floor(inputNum * 1000) : Math.floor(inputNum);

        const isoTime = new Date(targetMs).toISOString();

        const body = {
            "origin": { "location": { "latLng": { "latitude": getCoord(local('par11'), 0), "longitude": getCoord(local('par11'), 1) } } },
            "destination": { "location": { "latLng": { "latitude": getCoord(local('par12'), 0), "longitude": getCoord(local('par12'), 1) } } },
            "travelMode": routeMode,
            "computeAlternativeRoutes": false
        };

        if (routeMode === "DRIVE") {
            body.departureTime = isoTime;
            body.routingPreference = "TRAFFIC_AWARE"; 
        } else if (routeMode === "TRANSIT") {
            if (local('par15') === "ARRIVE") body.arrivalTime = isoTime;
            else body.departureTime = isoTime;
        }

        const rqOrigin = (local('par11') || "").trim();
        const rqDest = (local('par12') || "").trim();
        if (rqOrigin && rqDest) {
            rqRegisterCorrelation(rqOrigin + "|" + rqDest + "|" + routeMode);
        }

        setLocal('api_request_body', JSON.stringify(body)); 
        setLocal('api_route_mode', routeMode);
    }

} catch(e) {
    flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
        component: "API_JSON_Build", severity: "error", code: "API_BUILD_FAULT", tripId: null,
        details: { message: String(e && e.message || e) } }));
}