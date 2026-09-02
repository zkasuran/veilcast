/// The alert engine, tested as a pure function.
///
/// A web host polls this on a timer and shows what comes back, so a wrong severity is a user who either
/// ignores a real problem or is interrupted by nothing. The rules live in one place precisely so they can
/// be pinned here rather than re-derived per host.

import { strict as assert } from "node:assert";
import test from "node:test";
import { deriveAlerts } from "../src/alerts.mjs";

const ONE = 10n ** 18n;
const healthy = { free: 100n * ONE, backing: 50n * ONE, insurance: 5n * ONE, capital: 150n * ONE, sharesTotal: 150n * ONE, balance: 155n * ONE, obligations: 155n * ONE, solvent: true };
const find = (result, id) => result.alerts.find((entry) => entry.id === id);

test("a healthy vault with nothing happening is quiet", () => {
    const result = deriveAlerts({ vault: healthy });
    assert.equal(result.quiet, true);
    assert.equal(result.alerts.length, 0);
});

test("insolvency is critical and says to stop", () => {
    // The invariant the Cairo suite fuzzes. Seeing it false on chain means something the tests do not
    // model, which is a full stop rather than a warning.
    const result = deriveAlerts({ vault: { ...healthy, solvent: false } });
    const alert = find(result, "vault-insolvent");
    assert.equal(alert.severity, "critical");
    assert.match(alert.action, /Stop trading/);
});

test("a firable stop that is also liquidatable outranks one that is not", () => {
    // The owner pays a liquidation penalty a stop would have avoided, so this one is time-sensitive.
    const racing = { marketId: 1, side: 0, positionKey: "0xaa", firable: true, alsoLiquidatable: true, healthBps: 700, priceBps: 2900, stopHit: true };
    const calm = { marketId: 2, side: 1, positionKey: "0xbb", firable: true, alsoLiquidatable: false, healthBps: 4000, priceBps: 7200, takeHit: true };
    const result = deriveAlerts({ vault: healthy, mandates: { mandates: [calm, racing] } });
    assert.equal(result.alerts[0].severity, "critical");
    assert.match(result.alerts[0].id, /mandate-racing-1-0-0xaa/);
    assert.equal(find(result, "mandates-firable").severity, "warning");
});

test("a mandate that is not firable produces nothing", () => {
    const result = deriveAlerts({
        vault: healthy,
        mandates: { mandates: [{ marketId: 1, side: 0, positionKey: "0xaa", firable: false, alsoLiquidatable: false }] },
    });
    assert.equal(result.quiet, true);
});

test("an empty insurance fund only matters while loans are outstanding", () => {
    // No backing means nothing to go bad, so an empty fund is not yet a problem.
    const idle = deriveAlerts({ vault: { ...healthy, insurance: 0n, backing: 0n } });
    assert.equal(find(idle, "insurance-empty"), undefined);
    const lending = deriveAlerts({ vault: { ...healthy, insurance: 0n } });
    assert.equal(find(lending, "insurance-empty").severity, "warning");
});

test("a dry vault is information rather than a fault", () => {
    const result = deriveAlerts({ vault: { ...healthy, free: 0n } });
    assert.equal(find(result, "vault-dry").severity, "info");
});

test("an LP whose shares are not payable is told, rather than discovering it as a revert", () => {
    const result = deriveAlerts({
        vault: healthy,
        lp: { shares: 10n * ONE, worth: 11n * ONE, withdrawableNow: 3n * ONE, quote: { amount: 11n * ONE, payable: false } },
    });
    const alert = find(result, "lp-not-payable");
    assert.equal(alert.severity, "info");
    assert.match(alert.detail, /lent out or seeded/);
});

test("an underwater LP position is reported without alarm", () => {
    const result = deriveAlerts({
        vault: healthy,
        lp: {
            shares: 10n * ONE,
            worth: 8n * ONE,
            withdrawableNow: 8n * ONE,
            quote: { amount: 8n * ONE, payable: true },
            result: { deposited: 10n * ONE, withdrawn: 0n, pnl: -2n * ONE },
        },
    });
    assert.equal(find(result, "lp-underwater").severity, "info");
});

test("keeper work names the best paying candidate", () => {
    const result = deriveAlerts({
        vault: healthy,
        keeper: { liquidatable: 2, candidates: [{ marketId: 3, side: 1, reward: 2n * ONE }] },
    });
    const alert = find(result, "keeper-work");
    assert.equal(alert.severity, "info");
    assert.match(alert.detail, /market 3 NO/);
});

test("alerts come back most severe first, whatever order they were derived in", () => {
    const result = deriveAlerts({
        vault: { ...healthy, free: 0n, insurance: 0n, solvent: false },
        keeper: { liquidatable: 1, candidates: [{ marketId: 0, side: 0, reward: ONE }] },
    });
    const ranks = result.alerts.map((entry) => entry.severity);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => ({ critical: 3, warning: 2, info: 1 })[b] - ({ critical: 3, warning: 2, info: 1 })[a]));
    assert.equal(result.counts.critical, 1);
});

test("a missing input contributes no alerts rather than a false all-clear", () => {
    // Nothing was passed, so nothing is known. Quiet must not be read as healthy, which is why the
    // command reports which sources it actually checked alongside this.
    const result = deriveAlerts({});
    assert.equal(result.quiet, true);
    assert.equal(result.alerts.length, 0);
});

test("the block is carried so a host can tell a fresh poll from a cached one", () => {
    const result = deriveAlerts({ vault: healthy, chain: { head: 1_234_567 } });
    assert.equal(result.atBlock, 1_234_567);
});
