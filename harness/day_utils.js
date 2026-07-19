// DST-safe UTC day-boundary helpers used by the DST regression test.
// Kept in a tiny harness module so the helpers can be unit-tested directly
// without booting the full Tasker vm sandbox.

const SECONDS_PER_DAY = 86400;

// INV-0.2: DST-safe day-boundary comparison. Both unixSec values are in UTC.
function isSameUTCDay(unixSecA, unixSecB) {
    const dA = new Date(unixSecA * 1000);
    const dB = new Date(unixSecB * 1000);
    return dA.getUTCFullYear() === dB.getUTCFullYear()
        && dA.getUTCMonth() === dB.getUTCMonth()
        && dA.getUTCDate() === dB.getUTCDate();
}

// INV-0.2: UTC midnight of the day containing unixSec (the "day boundary" in UTC).
function utcDayBoundaryUnix(unixSec) {
    const d = new Date(unixSec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

module.exports = { isSameUTCDay: isSameUTCDay, utcDayBoundaryUnix: utcDayBoundaryUnix, SECONDS_PER_DAY: SECONDS_PER_DAY };
