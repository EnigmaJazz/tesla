# Dedup Report — 2026-07-19 Baseline

Scope: every `.js` file under `Backup/` (16 files) and under `drive-download-20260719T140259Z-1-001/` at the top level (17 files). The nested `drive-download-20260719T140259Z-1-001/Backup/` is byte-identical to the top-level `Backup/` (verified via `diff -q`) and is out of scope per the brief.

Live root count: **17** `.js` files (the brief said 18, but `ls *.js` returns 17; the duplicate `API_Parser.js` in the brief is a sanity-check, not an actual file).

## Summary

- Total duplicates inspected: **33**
- `IDENTICAL`: **17**
- `LIVE_NEWER` (root has content the duplicate lacks): **14**
- `DUP_NEWER` (duplicate has content the live script lacks — DO NOT auto-apply): **0**
- `NO_LIVE_COUNTERPART` (no root script with that basename, e.g. legacy `*1.js`): **2**

**Hypothesis check (drive-download is canonical):** every live root mtime matches the corresponding `drive-download-20260719T140259Z-1-001/*.js` mtime to the second, and every `Backup/*.js` mtime is older. The `IDENTICAL` count below is the decisive signal: if drive-download is the most-recent mirror, the bytes should match the live root for those 17 basenames. See table.

## Per-file results

| # | Duplicate | Class | Dup size | Dup mtime | Live size | Live mtime | Diff |
|---|---|---|---|---|---|---|---|
| 1 | `Backup/API_JSON_Build.js` | **LIVE_NEWER** | 2355 | 2026-07-11T23:40:58Z | 2905 | 2026-07-14T22:41:46Z | `differ` |
| 2 | `Backup/API_Parser.js` | **LIVE_NEWER** | 4762 | 2026-07-11T23:41:56Z | 6490 | 2026-07-17T12:09:52Z | `differ` |
| 3 | `Backup/Alpha.js` | **LIVE_NEWER** | 16533 | 2026-07-11T23:33:04Z | 18522 | 2026-07-17T13:38:12Z | `differ` |
| 4 | `Backup/Appender.js` | **LIVE_NEWER** | 4473 | 2026-07-07T14:10:32Z | 7171 | 2026-07-07T14:11:04Z | `differ` |
| 5 | `Backup/Compiler.js` | **LIVE_NEWER** | 14924 | 2026-07-18T15:28:34Z | 16598 | 2026-07-18T23:54:30Z | `differ` |
| 6 | `Backup/Compiler1.js` | **NO_LIVE_COUNTERPART** | 14047 | 2026-07-17T22:40:12Z | — | — | `no live counterpart` |
| 7 | `Backup/Dashboard.js` | **LIVE_NEWER** | 19224 | 2026-07-12T02:11:42Z | 21673 | 2026-07-17T12:11:46Z | `differ` |
| 8 | `Backup/Default.js` | **LIVE_NEWER** | 2562 | 2026-07-07T14:12:42Z | 4227 | 2026-07-07T14:13:10Z | `differ` |
| 9 | `Backup/Depart_Now.js` | **LIVE_NEWER** | 1261 | 2026-07-17T12:14:56Z | 2102 | 2026-07-17T12:16:34Z | `differ` |
| 10 | `Backup/Dispatcher.js` | **LIVE_NEWER** | 7764 | 2026-07-12T02:11:42Z | 9975 | 2026-07-17T12:12:36Z | `differ` |
| 11 | `Backup/Finaliser.js` | **LIVE_NEWER** | 3811 | 2026-07-11T23:37:16Z | 10000 | 2026-07-17T12:08:42Z | `differ` |
| 12 | `Backup/Gatekeeper.js` | **LIVE_NEWER** | 4554 | 2026-07-11T23:38:10Z | 7423 | 2026-07-17T12:09:20Z | `differ` |
| 13 | `Backup/Override_Injector.js` | **LIVE_NEWER** | 1961 | 2026-07-06T22:48:40Z | 6720 | 2026-07-05T09:07:08Z | `differ` |
| 14 | `Backup/Return_to_Base.js` | **LIVE_NEWER** | 2974 | 2026-07-05T08:13:56Z | 4327 | 2026-07-17T12:14:24Z | `differ` |
| 15 | `Backup/Sandbox_Engine.js` | **LIVE_NEWER** | 71252 | 2026-07-18T15:28:34Z | 72419 | 2026-07-18T22:41:52Z | `differ` |
| 16 | `Backup/Sandbox_Engine1.js` | **NO_LIVE_COUNTERPART** | 67062 | 2026-07-17T22:40:12Z | — | — | `no live counterpart` |
| 17 | `drive-download-20260719T140259Z-1-001/API_JSON_Build.js` | **IDENTICAL** | 2905 | 2026-07-14T22:41:46Z | 2905 | 2026-07-14T22:41:46Z | `identical` |
| 18 | `drive-download-20260719T140259Z-1-001/API_Parser.js` | **IDENTICAL** | 6490 | 2026-07-17T12:09:52Z | 6490 | 2026-07-17T12:09:52Z | `identical` |
| 19 | `drive-download-20260719T140259Z-1-001/Alpha.js` | **IDENTICAL** | 18522 | 2026-07-17T13:38:12Z | 18522 | 2026-07-17T13:38:12Z | `identical` |
| 20 | `drive-download-20260719T140259Z-1-001/Appender.js` | **IDENTICAL** | 7171 | 2026-07-07T14:11:04Z | 7171 | 2026-07-07T14:11:04Z | `identical` |
| 21 | `drive-download-20260719T140259Z-1-001/Compiler.js` | **IDENTICAL** | 16598 | 2026-07-18T23:54:30Z | 16598 | 2026-07-18T23:54:30Z | `identical` |
| 22 | `drive-download-20260719T140259Z-1-001/Dashboard.js` | **IDENTICAL** | 21673 | 2026-07-17T12:11:46Z | 21673 | 2026-07-17T12:11:46Z | `identical` |
| 23 | `drive-download-20260719T140259Z-1-001/Default.js` | **IDENTICAL** | 4227 | 2026-07-07T14:13:10Z | 4227 | 2026-07-07T14:13:10Z | `identical` |
| 24 | `drive-download-20260719T140259Z-1-001/Depart_Now.js` | **IDENTICAL** | 2102 | 2026-07-17T12:16:34Z | 2102 | 2026-07-17T12:16:34Z | `identical` |
| 25 | `drive-download-20260719T140259Z-1-001/Dispatcher.js` | **IDENTICAL** | 9975 | 2026-07-17T12:12:36Z | 9975 | 2026-07-17T12:12:36Z | `identical` |
| 26 | `drive-download-20260719T140259Z-1-001/Finaliser.js` | **IDENTICAL** | 10000 | 2026-07-17T12:08:42Z | 10000 | 2026-07-17T12:08:42Z | `identical` |
| 27 | `drive-download-20260719T140259Z-1-001/Gatekeeper.js` | **IDENTICAL** | 7423 | 2026-07-17T12:09:20Z | 7423 | 2026-07-17T12:09:20Z | `identical` |
| 28 | `drive-download-20260719T140259Z-1-001/Override_Injector.js` | **IDENTICAL** | 6720 | 2026-07-05T09:07:08Z | 6720 | 2026-07-05T09:07:08Z | `identical` |
| 29 | `drive-download-20260719T140259Z-1-001/Return_to_Base.js` | **IDENTICAL** | 4327 | 2026-07-17T12:14:24Z | 4327 | 2026-07-17T12:14:24Z | `identical` |
| 30 | `drive-download-20260719T140259Z-1-001/Sandbox_Engine.js` | **IDENTICAL** | 72419 | 2026-07-18T22:41:52Z | 72419 | 2026-07-18T22:41:52Z | `identical` |
| 31 | `drive-download-20260719T140259Z-1-001/Stop_Logger.js` | **IDENTICAL** | 2146 | 2026-07-14T13:58:08Z | 2146 | 2026-07-14T13:58:08Z | `identical` |
| 32 | `drive-download-20260719T140259Z-1-001/TDS_Helper.js` | **IDENTICAL** | 1009 | 2026-07-04T23:27:42Z | 1009 | 2026-07-04T23:27:42Z | `identical` |
| 33 | `drive-download-20260719T140259Z-1-001/Unlock.js` | **IDENTICAL** | 477 | 2026-07-04T13:40:26Z | 477 | 2026-07-04T13:40:26Z | `identical` |

## Detail per pair

### 1. `Backup/API_JSON_Build.js` — **LIVE_NEWER**

- Live: `API_JSON_Build.js` (2905 bytes, mtime 2026-07-14T22:41:46Z)
- Dup: 2355 bytes, mtime 2026-07-11T23:40:58Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/API_JSON_Build.js	2026-07-14 23:41:46.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/API_JSON_Build.js	2026-07-12 00:40:58.000000000 +0100
@@ -1,6 +1,7 @@
 // ==========================================
-// PRE-API PAYLOAD BUILDER (Hardened V4.1)
-// Parses JSON straight from %par1 for clusters.
+// PRE-API PAYLOAD BUILDER (Hardened V3)
+// Cures the TRAFFIC_UNAWARE 400 crash via explicit routingPreference enums,
+// strictly strips timestamps from pedestrian routes, and forces ISO-8601.
 // ==========================================
 
 function getCoord(rawStr, splitIndex) {
@@ -11,59 +12,59 @@
 }
 
 try {
-    var rawPar1 = local('par1') || "";
+    var rawMode = local('par13') || "DRIVE";
+    var routeMode = (rawMode === "TRANSIT") ? "TRANSIT" : ((rawMode === "WALK") ? "WALK" : "DRIVE");
+
... (104 more lines)
```

### 2. `Backup/API_Parser.js` — **LIVE_NEWER**

- Live: `API_Parser.js` (6490 bytes, mtime 2026-07-17T12:09:52Z)
- Dup: 4762 bytes, mtime 2026-07-11T23:41:56Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/API_Parser.js	2026-07-17 13:09:52.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/API_Parser.js	2026-07-12 00:41:56.000000000 +0100
@@ -1,75 +1,34 @@
 // ==========================================
-// API RESULT PARSER (TCS-7 V12.7)
-// Extracts optimizedWaypoint routing for Cluster arrays.
-// [V12.7] Safe array insertion and null-safe transit time parsing.
+// API RESULT PARSER (TCS-7 V12.4 - FILE TEMP CACHE)
+// Encapsulated to prevent sandbox leaks.
+// Writes API outputs natively to the Temp Cache flat file.
+// FIXED: Allows 0-values for proxy routing and casts strings safely.
 // ==========================================
 
 (function() {
     function forceSeconds(val) {
         let v = parseFloat(val); 
+        // Changed to < 0 so we don't reject 0-second proxies
         if (isNaN(v) || v < 0) return 0; 
         return Math.floor(v); 
     }
... (139 more lines)
```

### 3. `Backup/Alpha.js` — **LIVE_NEWER**

- Live: `Alpha.js` (18522 bytes, mtime 2026-07-17T13:38:12Z)
- Dup: 16533 bytes, mtime 2026-07-11T23:33:04Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Alpha.js	2026-07-17 14:38:12.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Alpha.js	2026-07-12 00:33:04.000000000 +0100
@@ -1,6 +1,8 @@
+
 // ==========================================
-// SCRIPT 1: MONOLITHIC ALPHA ENGINE V18.2
-// [V18.2] Repaired Holiday/Leave regex to prevent `#leave` tag conflicts.
+// SCRIPT 1: MONOLITHIC ALPHA ENGINE V16.9
+// Fully migrated to Tasker/Tesla/Data/ directory structure.
+// Includes strict, directional garbage collection for Overrides.
 // ==========================================
 
 let rawAutoBase = parseFloat(global('Auto_Base_Hours'));
@@ -39,8 +41,6 @@
 }
 
 try {
-    try { writeFile("Tasker/Tesla/Data/TDS_Optimize_Queue.json", "[]", false); } catch(e){}
-
     let nowSec       = Math.floor(Date.now() / 1000);
... (183 more lines)
```

### 4. `Backup/Appender.js` — **LIVE_NEWER**

- Live: `Appender.js` (7171 bytes, mtime 2026-07-07T14:11:04Z)
- Dup: 4473 bytes, mtime 2026-07-07T14:10:32Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Appender.js	2026-07-07 15:11:04.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Appender.js	2026-07-07 15:10:32.000000000 +0100
@@ -1,7 +1,6 @@
 // ==========================================
-// UNIVERSAL APPENDER (V10.3)
+// UNIVERSAL APPENDER (V10.0)
 // Fully migrated to Tasker/Tesla/Data/ directory structure.
-// Categorized wiping protects orthogonal overrides and history streaks.
 // ==========================================
 try {
     var choice = local('final_return') || "";
@@ -29,6 +28,7 @@
 
         var allArrays = [ "Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives", "Skipped_Events", "Forced_Lift_Chains", "Forced_Drive_Chains", "Skipped_Pitstops", "Forced_Pitstops", "Ignored_Lateness", "Ignored_Walks", "Trimmed_Events", "Route_History", "Route_Defaults" ];
 
+        // --- SINGLE FILE I/O LOAD ---
         var filePath = "Tasker/Tesla/Data/TDS_Overrides.json";
         var rawFile = readFile(filePath) || "{}";
         var mem = {};
@@ -39,22 +39,8 @@
... (79 more lines)
```

### 5. `Backup/Compiler.js` — **LIVE_NEWER**

- Live: `Compiler.js` (16598 bytes, mtime 2026-07-18T23:54:30Z)
- Dup: 14924 bytes, mtime 2026-07-18T15:28:34Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Compiler.js	2026-07-19 00:54:30.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Compiler.js	2026-07-18 16:28:34.000000000 +0100
@@ -1,21 +1,14 @@
 // ==========================================
-// SCRIPT 4: UNIFIED COMPILER (v24.18)
+// SCRIPT 4: UNIFIED COMPILER (v24.9)
 // Translates multiple #stop:XX delays into physical Calendar travel blocks.
 // Exports pending stops into Itin_Master for Tasker UI integration.
-// [V24.18] Merged V24.17 Tasker-safe dummy array injection ("IGNORE")
-//          while preserving V24.16 conflict detection, Hold/Flush JIT,
-//          active-travel fallback recalculation, and stop padding behaviour.
+// [V24.9] Artificial #leave Buffer padding for UI polish & JIT handshake fix.
 // ==========================================
 
 function getDist(lat1, lon1, lat2, lon2) {
-    const R = 6371e3; 
-    const rLat1 = lat1 * Math.PI / 180; 
-    const rLat2 = lat2 * Math.PI / 180;
-    const dLat = (lat2 - lat1) * Math.PI / 180; 
-    const dLon = (lon2 - lon1) * Math.PI / 180;
... (625 more lines)
```

### 6. `Backup/Compiler1.js` — **NO_LIVE_COUNTERPART**

- Live: _no counterpart at root_
- Dup: 14047 bytes, mtime 2026-07-17T22:40:12Z
- Diff status: `no live counterpart`

```diff
no live counterpart
```

### 7. `Backup/Dashboard.js` — **LIVE_NEWER**

- Live: `Dashboard.js` (21673 bytes, mtime 2026-07-17T12:11:46Z)
- Dup: 19224 bytes, mtime 2026-07-12T02:11:42Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Dashboard.js	2026-07-17 13:11:46.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Dashboard.js	2026-07-12 03:11:42.000000000 +0100
@@ -1,8 +1,11 @@
 // ==========================================
-// V6 DASHBOARD RENDERER (v9.0)
-// - Locks pre-flight trip buttons (Pitstop, Drive Instead) to a 2hr window.
-// - Keeps active trips visible until physical arrival/completion.
-// [V9.0] Fixed Sentry Mode multiplier bug and flexible single-digit regex.
+// V6 DASHBOARD RENDERER (v8.2)
+// - Hard-capped to 10 lines maximum for AutoNotification limits.
+// - Inlines Day prefixes and compacts empty days.
+// - Inlines Lateness/Buffer alerts (only shows buffer if reduced).
+// - Guarantees the native Battery string is always the final line.
+// - Suppresses meaningless buffer/lateness warnings for End of Day returns.
+// - Strips 'Start:' and 'End:' prefixes from proxy markers for cleaner UI.
 // ==========================================
 
 function getDist(lat1, lon1, lat2, lon2) {
@@ -46,6 +49,9 @@
     var now_sec = Math.floor(Date.now() / 1000);
... (277 more lines)
```

### 8. `Backup/Default.js` — **LIVE_NEWER**

- Live: `Default.js` (4227 bytes, mtime 2026-07-07T14:13:10Z)
- Dup: 2562 bytes, mtime 2026-07-07T14:12:42Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Default.js	2026-07-07 15:13:10.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Default.js	2026-07-07 15:12:42.000000000 +0100
@@ -1,7 +1,7 @@
 // ==========================================
-// TDS DEFAULT MANAGER (v1.3 Smart Categorization)
+// TDS DEFAULT MANAGER (v1.2 True History Wipe)
 // Unified script to Set or Wipe Defaults in JSON.
-// Separates Mode, Lateness, and Walk histories so they don't wipe each other.
+// Strips mode from signature to completely wipe all competing route history.
 // ==========================================
 
 try {
@@ -24,19 +24,12 @@
         mem.Route_History = "";
     } else if (targetKey !== "") {
         
+        // Isolate the base routine signature by stripping the transport mode
         var tkParts = targetKey.split("^");
-        var baseRoutineKey = targetKey;
-        var modifier = "";
... (75 more lines)
```

### 9. `Backup/Depart_Now.js` — **LIVE_NEWER**

- Live: `Depart_Now.js` (2102 bytes, mtime 2026-07-17T12:16:34Z)
- Dup: 1261 bytes, mtime 2026-07-17T12:14:56Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Depart_Now.js	2026-07-17 13:16:34.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Depart_Now.js	2026-07-17 13:14:56.000000000 +0100
@@ -1,7 +1,6 @@
 // ==========================================
-// TDS ACTION: DEPART NOW (v1.2)
+// TDS ACTION: DEPART NOW (v1.1)
 // Modifies departure time immediately and suppresses lateness alert triggers.
-// [V1.2] Force-clears lateness halts. Applies exact UI Status suffixes.
 // ==========================================
 
 try {
@@ -16,7 +15,6 @@
         let leg = itinerary[0];
         let originalDuration = leg.durationSecs || 1800;
 
-        // Shift timestamps to simulate immediate departure
         leg.departUnix = nowSec;
         leg.arriveUnix = nowSec + originalDuration;
         
@@ -33,23 +31,7 @@
... (24 more lines)
```

### 10. `Backup/Dispatcher.js` — **LIVE_NEWER**

- Live: `Dispatcher.js` (9975 bytes, mtime 2026-07-17T12:12:36Z)
- Dup: 7764 bytes, mtime 2026-07-12T02:11:42Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Dispatcher.js	2026-07-17 13:12:36.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Dispatcher.js	2026-07-12 03:11:42.000000000 +0100
@@ -1,8 +1,7 @@
 // ==========================================
-// UNIFIED PRE-FLIGHT DISPATCHER V15.1
-// Breaks multi-waypoint payloads at overnight bounds to prevent day-bleeding.
-// Implements 'Shrinking Tail' subset logic for Multi-Waypoint anti-spam.
-// [V15.1] Flawed synthetic EOD removed. Relies strictly on Sandbox spatial EOD generation.
+// UNIFIED PRE-FLIGHT DISPATCHER V14.4
+// Implements Imminent HVAC window vs Future Scheduling.
+// Handles Google Maps idempotency locally.
 // ==========================================
 
 function getDist(lat1, lon1, lat2, lon2) {
@@ -35,7 +34,6 @@
     var master = JSON.parse(masterRaw);
 
     var targetDrive = null;
-    var driveIdx = -1;
 
... (152 more lines)
```

### 11. `Backup/Finaliser.js` — **LIVE_NEWER**

- Live: `Finaliser.js` (10000 bytes, mtime 2026-07-17T12:08:42Z)
- Dup: 3811 bytes, mtime 2026-07-11T23:37:16Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Finaliser.js	2026-07-17 13:08:42.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Finaliser.js	2026-07-12 00:37:16.000000000 +0100
@@ -1,18 +1,9 @@
 // ==========================================
-// SCRIPT 3: ENGINE FINALISER (v25.1)
-// 12-Hour Geofence Limit: Only monitors locations starting within 12 hours.
-// Geofence Limit: Stops generating geofences after the first strict event.
-// Applies Sequence & Temporal Breaking to isolate Multi-Dropin Clustering.
-// [V25.1] Time-Gap collision fix, Strict Event Purge Protection. Gravity threshold moved to Sandbox.
+// SCRIPT 3: ENGINE FINALISER (v24.2)
+// Integrates manual override lock logic to protect dynamic legs.
+// Fully migrated to Tasker/Tesla/Data/ structure.
 // ==========================================
 
-function getDist(lat1, lon1, lat2, lon2) {
-    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
-    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
-    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
-    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
-}
... (206 more lines)
```

### 12. `Backup/Gatekeeper.js` — **LIVE_NEWER**

- Live: `Gatekeeper.js` (7423 bytes, mtime 2026-07-17T12:09:20Z)
- Dup: 4554 bytes, mtime 2026-07-11T23:38:10Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Gatekeeper.js	2026-07-17 13:09:20.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Gatekeeper.js	2026-07-12 00:38:10.000000000 +0100
@@ -1,166 +1,108 @@
 // ==========================================
-// SMART CACHE GATEKEEPER (V7.0)
-// Intercepts JSON Clusters on %par1. 
-// Uses isClose for GPS drift caching. Merges Master Sorter logic.
-// [V7.0] In-Place Array Sorting to protect Strict Event chronology.
+// SMART CACHE GATEKEEPER (V6.7 FILE I/O)
+// Updates L1/L2 terminology to reflect NVMe storage.
 // ==========================================
 
-(function() {
-    function forceSeconds(val) {
-        let v = parseFloat(val); 
-        if (isNaN(v) || v <= 0) return 0;
-        return Math.floor(v); 
-    }
-
-    function safeGet(varName) {
... (241 more lines)
```

### 13. `Backup/Override_Injector.js` — **LIVE_NEWER**

- Live: `Override_Injector.js` (6720 bytes, mtime 2026-07-05T09:07:08Z)
- Dup: 1961 bytes, mtime 2026-07-06T22:48:40Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Override_Injector.js	2026-07-05 10:07:08.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Override_Injector.js	2026-07-06 23:48:40.000000000 +0100
@@ -1,7 +1,6 @@
 // ==========================================
-// TDS OVERRIDE INJECTOR (v1.1)
+// TDS OVERRIDE INJECTOR (v1.0)
 // Reads an Event ID from Itin_Master and toggles it in TDS_Overrides.
-// Upgraded with Categorized Wiping and Route History integration.
 // ==========================================
 
 try {
@@ -11,7 +10,7 @@
     
     if (isNaN(idx) || !overrideKey) throw new Error("Missing parameters");
 
-    // 1. Extract Target ID and Coordinates from Itin_Master
+    // 1. Extract Target ID from Itin_Master
     let itinRaw = "";
     try { itinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]"; } catch(e) { itinRaw = "[]"; }
     let itin = JSON.parse(itinRaw);
... (127 more lines)
```

### 14. `Backup/Return_to_Base.js` — **LIVE_NEWER**

- Live: `Return_to_Base.js` (4327 bytes, mtime 2026-07-17T12:14:24Z)
- Dup: 2974 bytes, mtime 2026-07-05T08:13:56Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Return_to_Base.js	2026-07-17 13:14:24.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Return_to_Base.js	2026-07-05 09:13:56.000000000 +0100
@@ -1,8 +1,7 @@
 // ==========================================
-// TDS RETURN TO BASE (Manual Injector v1.3)
+// TDS RETURN TO BASE (Manual Injector v1.1)
 // Fully migrated to Tasker/Tesla/Data/ directory structure.
 // Engages TDS_Action_Lock to suppress Heartbeat during manual routing.
-// [V1.3] Vehicle proximity check for AUTO mode. Dynamically resolves TRANSIT/LIFT.
 // ==========================================
 
 function getDist(lat1, lon1, lat2, lon2) {
@@ -14,46 +13,21 @@
 
 try {
     let rCoords = global('TDS_Return_Coords');
-    let rawMode = global('TDS_Return_Mode') || "DRIVE";
+    let rMode = global('TDS_Return_Mode') || "DRIVE";
     let rName = global('TDS_Return_Name') || "Base";
     let nowSec = Math.floor(Date.now() / 1000);
... (79 more lines)
```

### 15. `Backup/Sandbox_Engine.js` — **LIVE_NEWER**

- Live: `Sandbox_Engine.js` (72419 bytes, mtime 2026-07-18T22:41:52Z)
- Dup: 71252 bytes, mtime 2026-07-18T15:28:34Z
- Diff status: `differ`

```diff
--- /home/james/ai-workspace/tasker/tesla/Sandbox_Engine.js	2026-07-18 23:41:52.000000000 +0100
+++ /home/james/ai-workspace/tasker/tesla/Backup/Sandbox_Engine.js	2026-07-18 16:28:34.000000000 +0100
@@ -1,9 +1,9 @@
 // ==========================================
-// V36 ENGINE SANDBOX (v16.5)
+// V36 ENGINE SANDBOX (v16.0)
 // - Drop-in Gravity: Evaluates Drop-ins against logical A-to-B trip windows on the fly.
 // - ASAP Dispatch: Engine routes immediately and pads wait time at destination.
 // - Ironclad Latch: Survives GPS drift while in meetings.
-// [V16.5] Chronological simAtBase tracking & Temporal Ghost Trip Attachment.
+// [V16.0] True API Unix Handshake for JIT & 10-Min Trip Windows.
 // ==========================================
 
 let GLOBAL_MASTER_ARR = [];
@@ -435,19 +435,6 @@
             }
         }
 
-        let simAtBase = false;
-        let oldItinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
... (154 more lines)
```

### 16. `Backup/Sandbox_Engine1.js` — **NO_LIVE_COUNTERPART**

- Live: _no counterpart at root_
- Dup: 67062 bytes, mtime 2026-07-17T22:40:12Z
- Diff status: `no live counterpart`

```diff
no live counterpart
```

### 17. `drive-download-20260719T140259Z-1-001/API_JSON_Build.js` — **IDENTICAL**

- Live: `API_JSON_Build.js` (2905 bytes, mtime 2026-07-14T22:41:46Z)
- Dup: 2905 bytes, mtime 2026-07-14T22:41:46Z
- Diff status: `identical`

```diff
identical
```

### 18. `drive-download-20260719T140259Z-1-001/API_Parser.js` — **IDENTICAL**

- Live: `API_Parser.js` (6490 bytes, mtime 2026-07-17T12:09:52Z)
- Dup: 6490 bytes, mtime 2026-07-17T12:09:52Z
- Diff status: `identical`

```diff
identical
```

### 19. `drive-download-20260719T140259Z-1-001/Alpha.js` — **IDENTICAL**

- Live: `Alpha.js` (18522 bytes, mtime 2026-07-17T13:38:12Z)
- Dup: 18522 bytes, mtime 2026-07-17T13:38:12Z
- Diff status: `identical`

```diff
identical
```

### 20. `drive-download-20260719T140259Z-1-001/Appender.js` — **IDENTICAL**

- Live: `Appender.js` (7171 bytes, mtime 2026-07-07T14:11:04Z)
- Dup: 7171 bytes, mtime 2026-07-07T14:11:04Z
- Diff status: `identical`

```diff
identical
```

### 21. `drive-download-20260719T140259Z-1-001/Compiler.js` — **IDENTICAL**

- Live: `Compiler.js` (16598 bytes, mtime 2026-07-18T23:54:30Z)
- Dup: 16598 bytes, mtime 2026-07-18T23:54:30Z
- Diff status: `identical`

```diff
identical
```

### 22. `drive-download-20260719T140259Z-1-001/Dashboard.js` — **IDENTICAL**

- Live: `Dashboard.js` (21673 bytes, mtime 2026-07-17T12:11:46Z)
- Dup: 21673 bytes, mtime 2026-07-17T12:11:46Z
- Diff status: `identical`

```diff
identical
```

### 23. `drive-download-20260719T140259Z-1-001/Default.js` — **IDENTICAL**

- Live: `Default.js` (4227 bytes, mtime 2026-07-07T14:13:10Z)
- Dup: 4227 bytes, mtime 2026-07-07T14:13:10Z
- Diff status: `identical`

```diff
identical
```

### 24. `drive-download-20260719T140259Z-1-001/Depart_Now.js` — **IDENTICAL**

- Live: `Depart_Now.js` (2102 bytes, mtime 2026-07-17T12:16:34Z)
- Dup: 2102 bytes, mtime 2026-07-17T12:16:34Z
- Diff status: `identical`

```diff
identical
```

### 25. `drive-download-20260719T140259Z-1-001/Dispatcher.js` — **IDENTICAL**

- Live: `Dispatcher.js` (9975 bytes, mtime 2026-07-17T12:12:36Z)
- Dup: 9975 bytes, mtime 2026-07-17T12:12:36Z
- Diff status: `identical`

```diff
identical
```

### 26. `drive-download-20260719T140259Z-1-001/Finaliser.js` — **IDENTICAL**

- Live: `Finaliser.js` (10000 bytes, mtime 2026-07-17T12:08:42Z)
- Dup: 10000 bytes, mtime 2026-07-17T12:08:42Z
- Diff status: `identical`

```diff
identical
```

### 27. `drive-download-20260719T140259Z-1-001/Gatekeeper.js` — **IDENTICAL**

- Live: `Gatekeeper.js` (7423 bytes, mtime 2026-07-17T12:09:20Z)
- Dup: 7423 bytes, mtime 2026-07-17T12:09:20Z
- Diff status: `identical`

```diff
identical
```

### 28. `drive-download-20260719T140259Z-1-001/Override_Injector.js` — **IDENTICAL**

- Live: `Override_Injector.js` (6720 bytes, mtime 2026-07-05T09:07:08Z)
- Dup: 6720 bytes, mtime 2026-07-05T09:07:08Z
- Diff status: `identical`

```diff
identical
```

### 29. `drive-download-20260719T140259Z-1-001/Return_to_Base.js` — **IDENTICAL**

- Live: `Return_to_Base.js` (4327 bytes, mtime 2026-07-17T12:14:24Z)
- Dup: 4327 bytes, mtime 2026-07-17T12:14:24Z
- Diff status: `identical`

```diff
identical
```

### 30. `drive-download-20260719T140259Z-1-001/Sandbox_Engine.js` — **IDENTICAL**

- Live: `Sandbox_Engine.js` (72419 bytes, mtime 2026-07-18T22:41:52Z)
- Dup: 72419 bytes, mtime 2026-07-18T22:41:52Z
- Diff status: `identical`

```diff
identical
```

### 31. `drive-download-20260719T140259Z-1-001/Stop_Logger.js` — **IDENTICAL**

- Live: `Stop_Logger.js` (2146 bytes, mtime 2026-07-14T13:58:08Z)
- Dup: 2146 bytes, mtime 2026-07-14T13:58:08Z
- Diff status: `identical`

```diff
identical
```

### 32. `drive-download-20260719T140259Z-1-001/TDS_Helper.js` — **IDENTICAL**

- Live: `TDS_Helper.js` (1009 bytes, mtime 2026-07-04T23:27:42Z)
- Dup: 1009 bytes, mtime 2026-07-04T23:27:42Z
- Diff status: `identical`

```diff
identical
```

### 33. `drive-download-20260719T140259Z-1-001/Unlock.js` — **IDENTICAL**

- Live: `Unlock.js` (477 bytes, mtime 2026-07-04T13:40:26Z)
- Dup: 477 bytes, mtime 2026-07-04T13:40:26Z
- Diff status: `identical`

```diff
identical
```

## Notes & risks

- Git state: `master` branch, **0 commits**. `git log` returns fatal. Any baseline commit is a fresh root commit; nothing to compare against.
- Out of scope: `.atl/`, `.gga/`, `openspec/`, `.git/`, and `drive-download-20260719T140259Z-1-001/Backup/` (byte-identical to top-level `Backup/`).
- Constraint: no root `.js` file was modified during this pass. The brief explicitly forbids drift into live code, even when a duplicate looks newer — only the report was produced.
- What to do next is a user decision; the report classifies but does not move files.
