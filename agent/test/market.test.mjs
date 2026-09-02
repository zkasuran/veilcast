/// Tests for the parimutuel maths and the raw-felt decoder.
///
/// The decoder is the part worth testing hard: `get_market_views` returns a nested Cairo structure whose
/// fields do not sit at fixed offsets, because a `ByteArray` is variable width. Getting the walk wrong
/// silently shifts every field after the question, which would show an agent the wrong odds on a live
/// market. The vectors here are the exact felts mainnet returns for market 0.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    decodeMarketViews,
    feeOn,
    impliedProbability,
    payoutMultiple,
    positionStatus,
    quotePayout,
    settledPayout,
} from "../src/market.mjs";

const ONE = 10n ** 18n;

/// The literal felts `get_market_views(0, 1)` returns from the deployed mainnet contract, captured on
/// 2026-09-01. Keeping the real bytes rather than a hand-built fixture means a serde change upstream
/// fails this test instead of quietly mis-decoding a board.
const MAINNET_MARKET_0 = [
    "0x1",
    "0x0",
    "0x7462cb6bb3f7ea8972e264124d80b68b1ff4c0fa17837d2eaa7216b7108132",
    "0x6a96b366",
    "0x6a8eca69",
    "0x43727970746f",
    "0x2",
    "0x2",
    "0x0",
    "0x6f05b59d3b20000",
    "0x0",
    "0x0",
    "0x0",
    "0x1",
    "0x57696c6c205354524b2074726164652061626f76652024302e3230206f6e20",
    "0x323032362d30392d33303f",
    "0xb",
    "0x2",
    "0x0",
    "0x596573",
    "0x3",
    "0x0",
    "0x4e6f",
    "0x2",
    "0x2",
    "0x6f05b59d3b20000",
    "0x0",
];

test("decodeMarketViews reads a real mainnet market, felt for felt", () => {
    const [view] = decodeMarketViews(MAINNET_MARKET_0);
    assert.equal(view.id, 0);
    assert.equal(view.question, "Will STRK trade above $0.20 on 2026-09-30?");
    assert.deepEqual(view.labels, ["Yes", "No"]);
    assert.deepEqual(view.volumes, [ONE / 2n, 0n]);
    assert.equal(view.pot, ONE / 2n);
    assert.equal(view.category, "Crypto");
    assert.equal(view.nOutcomes, 2);
    assert.equal(view.state, "Void");
    assert.equal(view.feeBps, 0);
    assert.equal(view.closeAt, 0x6a96b366);
    // The resolver is our own deployer, which is what makes this market voidable by us.
    assert.match(view.resolver, /^0x7462cb6b/);
});

test("the decoder walks past a variable-width question rather than indexing fixed offsets", () => {
    // A one-character question shifts every later field by two felts against the vector above. If the
    // walk were offset-based the labels and volumes would come back as garbage.
    const short = [
        "0x1", "0x5",
        "0x1", "0x64", "0x63", "0x0", "0x1", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0",
        "0x0", "0x41", "0x1",              // question: no full words, pending "A", length 1
        "0x1", "0x0", "0x596573", "0x3",   // one label: "Yes"
        "0x1", "0x2a",                     // one volume: 42
    ];
    const [view] = decodeMarketViews(short);
    assert.equal(view.id, 5);
    assert.equal(view.question, "A");
    assert.deepEqual(view.labels, ["Yes"]);
    assert.deepEqual(view.volumes, [42n]);
});

test("decodeMarketViews handles an empty board and several markets in one call", () => {
    assert.deepEqual(decodeMarketViews(["0x0"]), []);
    const two = [...MAINNET_MARKET_0.slice(1), ...MAINNET_MARKET_0.slice(1)];
    const views = decodeMarketViews(["0x2", ...two]);
    assert.equal(views.length, 2);
    assert.equal(views[0].question, views[1].question);
});

test("feeOn truncates exactly as the contract computes it", () => {
    assert.equal(feeOn(1000n, 0), 0n);
    assert.equal(feeOn(1000n, 500), 50n); // 5%
    assert.equal(feeOn(7n, 500), 0n); // truncates rather than rounding up
    assert.equal(feeOn(100n * ONE, 250), (100n * ONE * 250n) / 10_000n);
});

test("impliedProbability splits an empty book evenly instead of dividing by zero", () => {
    assert.equal(impliedProbability(0n, 0n, 2), 0.5);
    assert.equal(impliedProbability(0n, 0n, 3), 1 / 3);
    assert.equal(impliedProbability(0n, 0n, 0), 0);
    assert.equal(impliedProbability(3n * ONE, 4n * ONE, 2), 0.75);
});

/// A market shaped like the mainnet board: two outcomes, a live pot, no fee.
function openMarket(volumes, { feeBps = 0 } = {}) {
    const pot = volumes.reduce((sum, volume) => sum + volume, 0n);
    return { state: "Open", volumes, pot, feeBps, feeOwed: 0n, nOutcomes: volumes.length, winningOutcome: 0 };
}

test("quotePayout counts the stake into both the pot and the winning side", () => {
    // 3 STRK on Yes, 1 on No. A further 1 STRK on Yes makes a 5 STRK pot over 4 STRK of Yes: 1.25 back.
    // These are the same numbers the Cairo suite pins in `test_quote_payout_tracks_the_book`.
    const view = openMarket([3n * ONE, ONE]);
    assert.equal(quotePayout(view, 0, ONE), (5n * ONE) / 4n);
    // The thin side pays more: a 5 STRK pot over 2 STRK of No stake returns 2.5.
    assert.equal(quotePayout(view, 1, ONE), (5n * ONE) / 2n);
});

test("an empty book can only ever return the stake itself", () => {
    const view = openMarket([0n, 0n]);
    assert.equal(quotePayout(view, 0, ONE), ONE);
    assert.equal(payoutMultiple(view, 0, ONE), 1);
});

test("a fee comes off the gross pot before the split", () => {
    const withFee = openMarket([3n * ONE, ONE], { feeBps: 500 });
    const gross = 5n * ONE;
    const expected = ((gross - gross / 20n) * ONE) / (4n * ONE);
    assert.equal(quotePayout(withFee, 0, ONE), expected);
    // And the fee makes the multiple strictly worse than the fee-free book.
    assert.ok(payoutMultiple(withFee, 0, ONE) < payoutMultiple(openMarket([3n * ONE, ONE]), 0, ONE));
});

test("payoutMultiple below 1.0 is the signal to refuse a bet", () => {
    // Piling onto the heavy side of a fee-charging book can return less than went in.
    const view = openMarket([100n * ONE, ONE], { feeBps: 500 });
    const multiple = payoutMultiple(view, 0, 10n * ONE);
    assert.ok(multiple < 1, `expected a losing multiple, got ${multiple}`);
});

test("settledPayout pays only the winning side; a void market refunds everyone", () => {
    const resolved = { state: "Resolved", winningOutcome: 0, volumes: [3n * ONE, ONE], pot: 4n * ONE, feeOwed: 0n, feeBps: 0, nOutcomes: 2 };
    // The whole 4 STRK pot splits across 3 STRK of winning stake.
    assert.equal(settledPayout(resolved, 0, 3n * ONE), 4n * ONE);
    assert.equal(settledPayout(resolved, 1, ONE), 0n, "a losing position is worth nothing");
    const voided = { ...resolved, state: "Void" };
    assert.equal(settledPayout(voided, 0, 3n * ONE), 3n * ONE, "void refunds the stake");
    assert.equal(settledPayout(voided, 1, ONE), ONE, "including on the losing side");
});

test("quotePayout defers to the settled maths once a market is no longer open", () => {
    const resolved = { state: "Resolved", winningOutcome: 0, volumes: [3n * ONE, ONE], pot: 4n * ONE, feeOwed: 0n, feeBps: 0, nOutcomes: 2 };
    assert.equal(quotePayout(resolved, 0, 3n * ONE), settledPayout(resolved, 0, 3n * ONE));
});

test("positionStatus gates what an agent may do with a coupon", () => {
    const open = { state: "Open", closeAt: 9_999_999_999, winningOutcome: 0, volumes: [ONE], pot: ONE, feeBps: 0, feeOwed: 0n, nOutcomes: 1 };
    assert.equal(positionStatus(open, 0, ONE), "live");
    assert.equal(positionStatus({ ...open, closeAt: 1 }, 0, ONE), "closed");
    assert.equal(positionStatus({ ...open, state: "Void" }, 0, ONE), "refundable");
    assert.equal(positionStatus({ ...open, state: "Resolved" }, 0, ONE), "won");
    assert.equal(positionStatus({ ...open, state: "Resolved" }, 1, ONE), "lost");
    // A zero stake means it was already collected, whatever the market says.
    assert.equal(positionStatus({ ...open, state: "Resolved" }, 0, 0n), "empty");
    assert.equal(positionStatus(undefined, 0, ONE), "live");
});
