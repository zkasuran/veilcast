/// Share pricing, the number an LP reads before burning a share.
///
/// The binding figure is `quote_remove_liquidity`, which the contract computes, so this covers only the
/// display helper. It is worth pinning anyway: the scaling is the part that goes wrong, so a price that
/// floors to zero would tell an LP their stake is worthless.

import { strict as assert } from "node:assert";
import test from "node:test";
import { sharePrice } from "../src/pricing.mjs";

const ONE = 10n ** 18n;

test("an empty vault prices 1:1, because the first deposit mints one for one", () => {
    assert.equal(sharePrice(0n, 0n), ONE);
});

test("a vault that has not moved prices 1:1", () => {
    assert.equal(sharePrice(100n * ONE, 100n * ONE), ONE);
});

test("fees accrue to every share, losses come off every share", () => {
    // Capital grows without minting, so each share is worth more.
    assert.equal(sharePrice(110n * ONE, 100n * ONE), (11n * ONE) / 10n);
    // Bad debt the insurance fund could not absorb is the mirror image.
    assert.equal(sharePrice(90n * ONE, 100n * ONE), (9n * ONE) / 10n);
});

test("a sub-unit price survives integer division", () => {
    // A third of a token must read as 0.333... rather than flooring to nothing.
    assert.equal(sharePrice(ONE, 3n * ONE), 333333333333333333n);
});

test("shares outstanding with no capital price at zero rather than throwing", () => {
    // Only reachable if losses wiped the vault. An LP is owed nothing, so saying so beats a crash.
    assert.equal(sharePrice(0n, 100n * ONE), 0n);
});

/// An LP's result, folded from their own deposit and withdrawal history.
///
/// The share balance cannot answer "am I up", because shares are minted at the price of the day. These
/// pin the folding and the sign, since a vault that took bad debt must report a loss rather than clamp.
import { lpResult } from "../src/pricing.mjs";

const add = (amount, shares) => ({ kind: "add", amount, shares });
const remove = (shares, amount) => ({ kind: "remove", amount, shares });

test("a flat vault shows no gain", () => {
    const r = lpResult([add(100n * ONE, 100n * ONE)], 100n * ONE);
    assert.equal(r.deposited, 100n * ONE);
    assert.equal(r.withdrawn, 0n);
    assert.equal(r.pnl, 0n);
    assert.equal(r.averageEntry, ONE);
});

test("fees earned show as a gain before anything is withdrawn", () => {
    // 100 in, now worth 112: the vault earned borrow fees and every share is worth more.
    const r = lpResult([add(100n * ONE, 100n * ONE)], 112n * ONE);
    assert.equal(r.pnl, 12n * ONE);
    assert.equal(r.basis, 100n * ONE);
});

test("a loss is reported as a negative rather than clamped to zero", () => {
    // Bad debt the insurance fund could not absorb. Hiding it would be worse than showing it.
    const r = lpResult([add(100n * ONE, 100n * ONE)], 91n * ONE);
    assert.equal(r.pnl, -9n * ONE);
});

test("realized and unrealized fold into one figure", () => {
    // In 100, took out 60, the rest is worth 55. Up 15 overall even though the holding is below basis.
    const r = lpResult([add(100n * ONE, 100n * ONE), remove(50n * ONE, 60n * ONE)], 55n * ONE);
    assert.equal(r.withdrawn, 60n * ONE);
    assert.equal(r.sharesBurned, 50n * ONE);
    assert.equal(r.pnl, 15n * ONE);
    // Basis is what is still at risk, so a withdrawal reduces it.
    assert.equal(r.basis, 40n * ONE);
});

test("average entry is the price paid across every deposit, not the last one", () => {
    // 100 at 1.00 then 60 at 1.20: 160 paid for 150 shares.
    const r = lpResult([add(100n * ONE, 100n * ONE), add(60n * ONE, 50n * ONE)], 0n);
    assert.equal(r.sharesMinted, 150n * ONE);
    assert.equal(r.averageEntry, (160n * ONE * ONE) / (150n * ONE));
});

test("a fully exited LP keeps its realized result", () => {
    // Nothing held, so worth is zero, but the profit taken on the way out still counts.
    const r = lpResult([add(100n * ONE, 100n * ONE), remove(100n * ONE, 118n * ONE)], 0n);
    assert.equal(r.pnl, 18n * ONE);
    assert.equal(r.basis, 0n);
});

test("no history is no average, rather than an average of zero", () => {
    const r = lpResult([], 0n);
    assert.equal(r.averageEntry, null);
    assert.equal(r.pnl, 0n);
});
