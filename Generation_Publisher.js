// Generation_Publisher.js — Phase 2 atomic commit boundary.

const PHASE2_MANIFEST_PATH = "Tasker/Tesla/Data/TDS_Run_Manifest.json";
const PHASE2_DATA_DIR = "Tasker/Tesla/Data/";
const PHASE2_REORDER_QUEUE_PATH = PHASE2_DATA_DIR + "TDS_Reorder_Commands.json";
const PHASE2_RETENTION = 5;
const ID_COLLISION_RETRY_MAX = 16;
const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_WRITER = "Generation Publisher";
const GENERATION_ID_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/;
const REORDER_COMMAND_TYPE = "APPLY_CLUSTER_REORDER";

function nowSec() { return Math.floor(Date.now() / 1000); }
function hex4(v) { let s = v.toString(16); while (s.length < 4) s = "0" + s; return s; }
function encodeGen(g) { return String(g).replace(/:/g, "_"); }
function pathFor(g, kind) {
  return PHASE2_DATA_DIR + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + encodeGen(g) + ".json";
}
function readReorderQueue() {
  const raw = readFile(PHASE2_REORDER_QUEUE_PATH) || "";
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function writeReorderQueue(commands) {
  writeFile(PHASE2_REORDER_QUEUE_PATH, JSON.stringify(commands));
}
function clearReorderQueue() {
  writeFile(PHASE2_REORDER_QUEUE_PATH, "[]");
  if (readFile(PHASE2_REORDER_QUEUE_PATH) !== "[]") {
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "reorder queue clear read-back mismatch" });
  }
}
function isSameUTCDay(unixSecA, unixSecB) {
  const dA = new Date(unixSecA * 1000);
  const dB = new Date(unixSecB * 1000);
  return dA.getUTCFullYear() === dB.getUTCFullYear()
      && dA.getUTCMonth() === dB.getUTCMonth()
      && dA.getUTCDate() === dB.getUTCDate();
}
function validateReorderCommand(cmd, master, events, committedGenId) {
  if (!cmd || cmd.type !== REORDER_COMMAND_TYPE) {
    return { valid: false, reason: "type mismatch" };
  }
  if (cmd.generationId && !GENERATION_ID_REGEX.test(cmd.generationId)) {
    return { valid: false, reason: "invalid generationId format" };
  }
  // Phase 4 (REQ-4REORDER-2): admission matches the PRE-BUILD committed
  // generation (the one active when the producer emitted) — never the minted
  // id. Legacy-null commands stay permitted (migration path).
  if (cmd.generationId && cmd.generationId !== committedGenId) {
    return { valid: false, reason: "stale generation" };
  }
  if (!Array.isArray(cmd.orderedEventIds) || cmd.orderedEventIds.length === 0) {
    return { valid: false, reason: "empty orderedEventIds" };
  }
  const seen = {};
  for (let i = 0; i < cmd.orderedEventIds.length; i++) {
    const id = cmd.orderedEventIds[i];
    if (!id || typeof id !== "string") return { valid: false, reason: "non-string event id" };
    if (seen[id]) return { valid: false, reason: "duplicate event id" };
    seen[id] = true;
  }
  const idSet = {};
  for (let i = 0; i < master.length; i++) idSet[master[i].id] = true;
  for (let i = 0; i < cmd.orderedEventIds.length; i++) {
    if (!idSet[cmd.orderedEventIds[i]]) return { valid: false, reason: "event id not in master" };
  }
  let dayAnchor = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (cmd.orderedEventIds.indexOf(ev.id) !== -1) {
      const start = parseInt(ev.start, 10) || 0;
      if (dayAnchor === 0) dayAnchor = start;
      else if (start > 0 && !isSameUTCDay(dayAnchor, start)) return { valid: false, reason: "cluster crosses UTC day" };
    }
  }
  return { valid: true };
}
function applyReorderCommand(master, cmd) {
  const targetIndices = [];
  const clusterMap = {};
  for (let i = 0; i < master.length; i++) {
    if (cmd.orderedEventIds.indexOf(master[i].id) !== -1) {
      targetIndices.push(i);
      clusterMap[master[i].id] = master[i];
    }
  }
  for (let j = 0; j < cmd.orderedEventIds.length; j++) {
    if (targetIndices[j] !== undefined && clusterMap[cmd.orderedEventIds[j]]) {
      master[targetIndices[j]] = clusterMap[cmd.orderedEventIds[j]];
    }
  }
  return master;
}
function drainReorderQueue(master, events, committedGenId) {
  const commands = readReorderQueue();
  let appliedCount = 0;
  let rejectedCount = 0;
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const validation = validateReorderCommand(cmd, master, events, committedGenId);
    if (validation.valid) {
      applyReorderCommand(master, cmd);
      appliedCount++;
    } else if (cmd.generationId && cmd.generationId !== committedGenId) {
      rejectedCount++;
      logEvent("warn", "STALE_REORDER_COMMAND_REJECTED", committedGenId || cmd.generationId, { source: cmd.source, reason: validation.reason, command: cmd });
    } else {
      rejectedCount++;
      logEvent("warn", "REORDER_COMMAND_REJECTED", committedGenId, { source: cmd.source, reason: validation.reason, command: cmd });
    }
  }
  if (appliedCount > 0) {
    logEvent("info", "REORDER_COMMANDS_APPLIED", committedGenId, { count: appliedCount, totalSeen: commands.length });
  }
  logEvent("info", "REORDER_QUEUE_DRAINED", committedGenId, { totalSeen: commands.length, applied: appliedCount, rejected: rejectedCount });
  clearReorderQueue();
  return master;
}
function logEvent(severity, code, genId, details) {
  flash(JSON.stringify({ timestamp: Date.now(), generationId: genId || null, component: "Generation_Publisher", severity: severity, code: code, tripId: null, details: details || {} }));
}
function readJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function writeWithReadback(path, content, genId) {
  writeFile(path, content);
  if (readFile(path) !== content) {
    logEvent("error", "GENERATION_VALIDATION_FAILED", genId, { path: path, reason: "read-back mismatch" });
    throw new Error("READ_BACK_MISMATCH: " + path);
  }
}
function used(id) {
  const m = readJson(PHASE2_MANIFEST_PATH);
  if (!m) return false;
  if (m.generationId === id || m.activeGeneration === id || m.previousGeneration === id) return true;
  const history = m.generationHistory;
  if (Array.isArray(history)) {
    for (let i = 0; i < history.length; i++) if (history[i] === id) return true;
  }
  return false;
}
function mintId() {
  for (let i = 0; i < ID_COLLISION_RETRY_MAX; i++) {
    const id = "gen:" + nowSec() + ":" + hex4(Math.floor(Math.random() * 0x10000));
    if (!used(id)) return id;
  }
  throw new Error("GENERATION_ID_COLLISION_RETRY_EXHAUSTED");
}
function manifest(genId, previous, counts, state, history, activeOverride) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generationId: genId,
    activeGeneration: activeOverride || (state === "committed" ? genId : null),
    previousGeneration: previous,
    publishedAt: nowSec(),
    writer: MANIFEST_WRITER,
    eventsPath: genId ? pathFor(genId, "events") : null,
    masterPath: genId ? pathFor(genId, "master") : null,
    itineraryPath: genId ? pathFor(genId, "itinerary") : null,
    eventCount: counts.events,
    legCount: counts.master,
    itineraryCount: counts.itinerary,
    generationHistory: history || [],
    state: state
  };
}
function publish(candidate) {
  let previousId = null;
  let genId = null;
  try {
    if (!candidate || !Array.isArray(candidate.events) || !Array.isArray(candidate.master) || !Array.isArray(candidate.itinerary)) {
      logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: "candidate invalid" });
      throw new Error("PUBLISH_CANDIDATE_INVALID");
    }
    genId = mintId();
    const prior = readJson(PHASE2_MANIFEST_PATH);
    previousId = prior && prior.state === "committed" ? prior.activeGeneration || prior.generationId : null;
    const history = prior && Array.isArray(prior.generationHistory) ? prior.generationHistory.slice() : [];
    const counts = { events: candidate.events.length, master: candidate.master.length, itinerary: candidate.itinerary.length };
    const evtPath = pathFor(genId, "events");
    const mstPath = pathFor(genId, "master");
    const itnPath = pathFor(genId, "itinerary");
    writeWithReadback(evtPath, JSON.stringify(candidate.events), genId);
    // Phase 4 (REQ-4REORDER-2): reorder commands match the pre-build committed
    // generation (previousId), never the newly minted genId.
    const reorderedMaster = drainReorderQueue(candidate.master.slice(), candidate.events, previousId);
    writeWithReadback(mstPath, JSON.stringify(reorderedMaster), genId);
    writeWithReadback(itnPath, JSON.stringify(candidate.itinerary), genId);
    writeWithReadback(PHASE2_MANIFEST_PATH, JSON.stringify(manifest(genId, previousId, counts, "committed", history)), genId);
    setGlobal("TDS_Active_Generation", genId);
    // Phase 3 PR-F: reconcile reducer state with the new active generation.
    // The manifest is authoritative; the reducer aligns its currentGeneration
    // and lastReconciledGeneration to genId.
    if (typeof reducer === "function") {
      try {
        // The reducer's validateCommon requires generationId in every payload.
        reducer("RECONCILE_GENERATION", { generationId: genId, activeGeneration: genId, manifestSchemaVersion: 2 });
      } catch (reconcileErr) {
        logEvent("warn", "RECONCILE_GENERATION", null, { reason: reconcileErr.message, generation: genId });
      }
    } else {
      // Real Tasker: stage the command for the next action to run the reducer.
      setLocal("par1", "RECONCILE_GENERATION");
      setLocal("par2", JSON.stringify({ generationId: genId, activeGeneration: genId, manifestSchemaVersion: 2 }));
    }
    prune();
    return genId;
  } catch (e) {
    setGlobal("TDS_Active_Generation", "");
    logEvent("error", "GENERATION_VALIDATION_FAILED", null, { reason: e.message });
    try {
      writeWithReadback(PHASE2_MANIFEST_PATH, JSON.stringify(manifest(genId, previousId, { events: 0, master: 0, itinerary: 0 }, "failed", [], previousId)), null);
    } catch (mErr) {}
    throw e;
  }
}
function prune() {
  const m = readJson(PHASE2_MANIFEST_PATH);
  if (!m || m.state !== "committed" || !m.activeGeneration) return;
  const history = m.generationHistory || [];
  if (history.indexOf(m.activeGeneration) === -1) history.unshift(m.activeGeneration);
  while (history.length > PHASE2_RETENTION) {
    const g = history.pop();
    if (g && g !== m.activeGeneration) {
      deleteFile(pathFor(g, "events"));
      deleteFile(pathFor(g, "master"));
      deleteFile(pathFor(g, "itinerary"));
    }
  }
  const updated = JSON.parse(JSON.stringify(m));
  updated.generationHistory = history;
  writeWithReadback(PHASE2_MANIFEST_PATH, JSON.stringify(updated), m.activeGeneration);
}
function migrateFromLegacy() {
  const master = readJson(PHASE2_DATA_DIR + "TDS_Master.json") || [];
  const itin = readJson(PHASE2_DATA_DIR + "Itin_Master.json") || [];
  if (!Array.isArray(master) || !Array.isArray(itin)) throw new Error("LEGACY_MASTER_INVALID");
  writeWithReadback(PHASE2_DATA_DIR + "TDS_Master.legacy.json", JSON.stringify(master), null);
  writeWithReadback(PHASE2_DATA_DIR + "Itin_Master.legacy.json", JSON.stringify(itin), null);
  return publish({ events: [], master: master, itinerary: itin });
}

const CANDIDATE = local("par1");
if (CANDIDATE === "MIGRATE") {
  try { setLocal("return_value", migrateFromLegacy()); } catch (e) { setLocal("return_value", "ERROR: " + e.message); }
} else if (CANDIDATE) {
  try { setLocal("return_value", publish(JSON.parse(CANDIDATE))); } catch (e) { setLocal("return_value", "ERROR: " + e.message); }
}
