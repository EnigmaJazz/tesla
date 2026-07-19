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
        
        for (var w = 0; w < cluster.waypoints.length; w++) {
            var wC = cluster.waypoints[w].coords.split(",");
            body.intermediates.push({
                "location": { "latLng": { "latitude": parseFloat(wC[0]), "longitude": parseFloat(wC[1]) } }
            });
        }
        
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

        setLocal('api_request_body', JSON.stringify(body)); 
        setLocal('api_route_mode', routeMode);
    }

} catch(e) { flash("Payload Builder JS Crash:\n" + e.message); }