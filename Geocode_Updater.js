// Geocode_Updater.js — device-maintained geocode-cache writer.
// Commits ONE Google Geocode API result for ONE location into
// Geocode_Cache.json (location string -> "lat,lon"). Alpha.js and
// Finaliser.js read that cache by exact normalized key
// (loc.trim().toLowerCase()), so the key committed here is normalized
// the same way.
//
// Device wiring: the Tasker task splits Alpha's %locs_to_fetch (^^-joined)
// into per-location runs; per run it calls the Google Geocode API and stages
// %http_data (the raw response JSON) and %loc_text (the location string),
// then runs this script.
//
// Inputs:  %http_data, %loc_text
// Outputs: %return_value, %local_geo_cache (courtesy copy of the written JSON)
// Writes:  Tasker/Tesla/Data/Geocode_Cache.json (read-modify-write, one key)
//
// Read-only apart from that one file. This script is the device-side writer
// of Geocode_Cache.json — Alpha/Finaliser only read it, so there is no
// single-writer conflict with the generation pipeline.

// IIFE wrapper (repo convention, cf. Gatekeeper/API_Parser/Cluster_Builder):
// the Tasker runtime and the harness vm both reject top-level `return`; the
// early returns inside the try block are legal only inside a function.
(function() {

// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";
// Normalize: a dataRoot without a trailing slash would silently concatenate into
// invalid paths (R4-WARNING on the extraction refactor).
if (DATA_ROOT.charAt(DATA_ROOT.length - 1) !== "/") { DATA_ROOT += "/"; }

const GEOCODE_CACHE_PATH = DATA_ROOT + "Geocode_Cache.json";
const COMPONENT = "Geocode_Updater";

try {

  function flashLog(severity, code, details) {
    let entry = {
      timestamp: Math.floor(Date.now() / 1000),
      generationId: global("TDS_Active_Generation") || null,
      component: COMPONENT,
      severity: severity,
      code: code,
      tripId: null,
      details: details || {}
    };
    flash(JSON.stringify(entry));
  }

  // --- Step 1: guard against empty / unexpanded %http_data ------------------
  let httpData = local("http_data");
  if (!httpData || httpData.charAt(0) === "%") {
    setLocal("return_value", "skip:no_data");
    return;
  }

  // --- Step 2: parse the response -------------------------------------------
  let res;
  try {
    res = JSON.parse(httpData);
  } catch (e) {
    flashLog("warn", "GEOCODE_RESPONSE_INVALID", { reason: String(e && e.message || e) });
    setLocal("return_value", "skip:invalid_json");
    return;
  }

  // --- Step 3: require a successful, non-empty result -----------------------
  if (!res || res.status !== "OK" || !res.results || res.results.length === 0) {
    flashLog("warn", "GEOCODE_RESPONSE_INVALID", { status: String(res && res.status) });
    setLocal("return_value", "skip:no_result");
    return;
  }

  // --- Step 4: extract finite coordinates -----------------------------------
  let lat = res.results[0].geometry.location.lat;
  let lon = res.results[0].geometry.location.lng;
  if (typeof lat !== "number" || !isFinite(lat) || typeof lon !== "number" || !isFinite(lon)) {
    flashLog("warn", "GEOCODE_RESPONSE_INVALID", { reason: "nonfinite_coords" });
    setLocal("return_value", "skip:nonfinite_coords");
    return;
  }

  // --- Step 5: normalize the cache key --------------------------------------
  let locText = local("loc_text") || "";
  let key = locText.trim().toLowerCase();
  if (key === "") {
    flashLog("warn", "GEOCODE_EMPTY_LOCATION", {});
    setLocal("return_value", "skip:empty_location");
    return;
  }

  // --- Step 6: read the existing cache --------------------------------------
  // Corrupt (non-empty, not an unexpanded variable, unparseable) JSON ABORTS
  // without writing: a silent reset would destroy the whole cache on the next
  // commit — the device scriptlet's data-loss bug this script fixes. Missing,
  // empty, or unexpanded raw -> start with an empty object.
  let raw = readFile(GEOCODE_CACHE_PATH);
  let cache = {};
  if (raw && raw.charAt(0) !== "%") {
    try {
      cache = JSON.parse(raw);
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("cache root must be a plain object");
    } catch (e) {
      flashLog("error", "GEOCODE_CACHE_CORRUPT_ABORT", { reason: String(e && e.message || e) });
      setLocal("return_value", "abort:corrupt_cache");
      return;
    }
  }

  // --- Step 7: merge and serialize -------------------------------------------
  let coords = lat + "," + lon;
  cache[key] = coords;
  let output = JSON.stringify(cache);
  let entryCount = Object.keys(cache).length;

  // --- Step 8: write ---------------------------------------------------------
  let writeResult;
  try {
    writeResult = writeFile(GEOCODE_CACHE_PATH, output);
  } catch (e) {
    flashLog("error", "GEOCODE_CACHE_WRITE_FAILED", { reason: String(e && e.message || e) });
    setLocal("return_value", "error:write_failed");
    return;
  }
  // Tasker's writeFile reports failure by returning false (and may throw);
  // treat only an explicit false as failure — undefined is a successful write.
  if (writeResult === false) {
    flashLog("error", "GEOCODE_CACHE_WRITE_FAILED", { reason: "writeFile returned false" });
    setLocal("return_value", "error:write_failed");
    return;
  }

  // --- Step 9: success --------------------------------------------------------
  setLocal("local_geo_cache", output);
  flashLog("info", "GEOCODE_CACHE_UPDATED", { key: key, coords: coords, entryCount: entryCount });
  setLocal("return_value", "ok:updated");

} catch (e) {
  // Outer catch — anything unexpected
  try {
    flashLog("error", "GEOCODE_UPDATER_FAULT", { message: String(e && e.message || e) });
  } catch (_) {
    // Can't even flash — nothing we can do
  }
  setLocal("return_value", "fault");
}

})();
