// Loads a Tasker script into the sandbox and runs it once.
// Captures any uncaught error on the store so the test can assert the
// script completed without throwing. The Compiler and Dispatcher each
// have their own outer try/catch, so most errors land in store.flashLog
// rather than store.runError; the runner's try/catch is the safety net.

const fs = require('node:fs');
const vm = require('node:vm');

function runScript(scriptPath, sandbox, store) {
  const code = fs.readFileSync(scriptPath, 'utf8');
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(code, ctx, { filename: scriptPath });
  } catch (e) {
    let line = null;
    if (e && typeof e.stack === 'string') {
      const m = e.stack.match(/:(\d+):/);
      if (m) line = parseInt(m[1], 10);
    }
    store.runError = { message: e && e.message ? e.message : String(e), line: line };
  }
  return store;
}

module.exports = { runScript: runScript };
