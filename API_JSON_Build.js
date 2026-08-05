// ==========================================
// PRE-API PAYLOAD BUILDER (Hardened V4.1)
// Parses JSON straight from %par1 for clusters.
// ==========================================

function getCoord(rawStr, splitIndex) {
    if (!rawStr || rawStr.indexOf("%") === 0) return 0.0;
    var parts = rawStr.split(",");
    var val = parseFloat(parts[splitIndex]);
    return isNaN(val) ? 0.0 : val;
}

// Phase 5 Slice C (REQ-5REQID-1): stamp a correlation envelope for the active
// generation and register the latest request with the Route Cache Manager
// BEFORE the wire body is sent. The envelope is staged into api_correlation
// (and par1/par2 as REQUEST_STATE_REGISTER for the manager); the Google Routes
// wire payload NEVER carries generationId/clusterId/requestId.
function rqRegisterCorrelation(clusterId) {
    var rqNow = Math.floor(Date.now() / 1000);
    var rqHex = ("0000" + Math.floor(Math.random() * 0x10000).toString(16)).slice(-4);
    var rqRequestId = "req:" + rqNow + ":" + rqHex;
    var rqGenerationId = global('TDS_Active_Generation') || null;
    setLocal('api_correlation', JSON.stringify({ generationId: rqGenerationId, clusterId: clusterId, requestId: rqRequestId }));
    setLocal('par1', 'REQUEST_STATE_REGISTER');
    setLocal('par2', JSON.stringify({ generationId: rqGenerationId, clusterId: clusterId, requestId: rqRequestId, emittedAt: rqNow }));
}

try {
    var rawPar1 = local('par1') || "";
    
    // --- CLUSTER FORK ---
    if (rawPar1.indexOf("{") === 0) {
        var cluster = JSON.parse(rawPar1);
        
        var uLoc = global('User_Loc') || "0,0";
        var body = {
            "origin": { "location": { "latLng": { "latitude": parseFloat(uLoc.split(",")[0]), "longitude": parseFloat(uLoc.split(",")[1]) } } },
            "destination": { "location": { "latLng": { "latitude": parseFloat(cluster.destination.coords.split(",")[0]), "longitude": parseFloat(cluster.destination.coords.split(",")[1]) } } },
            "travelMode": "DRIVE",
            "optimizeWaypointOrder": true, 
            "intermediates": []
        };
        
        var rqWpIds = [];
        for (var w = 0; w < cluster.waypoints.length; w++) {
            var wC = cluster.waypoints[w].coords.split(",");
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
        var rawMode = local('par13') || "DRIVE";
        var routeMode = (rawMode === "TRANSIT") ? "TRANSIT" : ((rawMode === "WALK") ? "WALK" : "DRIVE");

        var targetMs = Date.now();
        var inputNum = parseFloat(local('par14'));
        if (!isNaN(inputNum) && inputNum > 0) targetMs = (inputNum < 20000000000) ? Math.floor(inputNum * 1000) : Math.floor(inputNum);

        var isoTime = new Date(targetMs).toISOString();

        var body = {
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

        var rqOrigin = (local('par11') || "").trim();
        var rqDest = (local('par12') || "").trim();
        if (rqOrigin && rqDest) {
            rqRegisterCorrelation(rqOrigin + "|" + rqDest + "|" + routeMode);
        }

        setLocal('api_request_body', JSON.stringify(body)); 
        setLocal('api_route_mode', routeMode);
    }

} catch(e) { flash("Payload Builder JS Crash:\n" + e.message); }