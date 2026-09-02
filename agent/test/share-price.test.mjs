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
