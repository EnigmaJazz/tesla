// Shared DST-safe LOCAL day-boundary helpers (INV-0.2: day comparisons use the
// configured local timezone — on a Tasker device the device timezone IS the
// configured timezone). Mirrors the inlined copies in Alpha.js,
// Sandbox_Engine.js, Finaliser.js, Compiler.js, and Dispatcher.js.
//
// DST safety: JS Date local getters resolve the local day exactly — a
// 23/24/25-hour day still has one unambiguous local midnight — so (y, m, d)
// equality and the local-midnight constructor are DST-safe by construction
// (unlike fixed-second arithmetic, which shifts across transitions).

const SECONDS_PER_DAY = 86400;

function isSameLocalDay(unixSecA, unixSecB) {
  const dA = new Date(unixSecA * 1000);
  const dB = new Date(unixSecB * 1000);
  return dA.getFullYear() === dB.getFullYear()
    && dA.getMonth() === dB.getMonth()
    && dA.getDate() === dB.getDate();
}

function localDayBoundaryUnix(unixSec) {
  const d = new Date(unixSec * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
}

module.exports = { isSameLocalDay: isSameLocalDay, localDayBoundaryUnix: localDayBoundaryUnix, SECONDS_PER_DAY: SECONDS_PER_DAY };
