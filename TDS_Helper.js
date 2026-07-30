// TDS_Helper — Phase 2 read-only manifest resolver.
// par1 = events|master|itinerary returns the active committed resource (prior/empty fallback).
// par1 = Filename:Index:Key returns legacy getter value.
// Direct writes to RULE-8A files are rejected.

const PHASE2_MANIFEST_PATH = "Tasker/Tesla/Data/TDS_Run_Manifest.json";
const PHASE2_DATA_DIR = "Tasker/Tesla/Data/";

function encodeGen(g) { return String(g).replace(/:/g, "_"); }
function pathFor(g, kind) {
  return PHASE2_DATA_DIR + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + encodeGen(g) + ".json";
}
function readJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function readActive(kind) {
  const m = readJson(PHASE2_MANIFEST_PATH);
  const key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
  if (m && m.state === "committed" && m.activeGeneration) {
    const data = readJson(m[key] || pathFor(m.activeGeneration, kind));
    if (data !== null) return data;
  }
  if (m && m.previousGeneration) {
    const data = readJson(pathFor(m.previousGeneration, kind));
    if (data !== null) return data;
  }
  return [];
}

try {
  const par1 = local("par1");
  const par2 = local("par2");
  if (par2 !== "") throw new Error("TDS_Helper generic setter is removed");
  const parts = String(par1).split(":");
  let result;
  if (parts[0] === "events" || parts[0] === "master" || parts[0] === "itinerary") {
    result = readActive(parts[0]);
  } else {
    const arr = readJson(PHASE2_DATA_DIR + parts[0] + ".json") || [];
    result = arr[parseInt(parts[1], 10)][parts[2]];
  }
  setLocal("return_value", typeof result === "string" ? result : JSON.stringify(result));
} catch (e) {
  setLocal("return_value", "ERROR: " + e.message);
}
