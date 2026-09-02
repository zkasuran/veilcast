/// Tests for the pure maths: the FPMM port and the leverage arithmetic.
///
/// Every vector here is pinned against the Cairo suite, which is the source of truth. The point is not
/// that the JavaScript is self-consistent; it is that a quote computed off-chain equals the number the
/// contract computes on-chain, so an agent never plans against a different reality than it trades in.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    buy,
    formatStrk,
    isqrt,
    keeperReward,
    mandateStatus,
    markPosition,
    parseStrk,
    priceBps,
    quoteOpen,
    sell,
    sidesOf,
} from "../src/pricing.mjs";

const ONE = 10n ** 18n;
const evenBook = { rYes: 100n * ONE, rNo: 100n * ONE };

test("isqrt floors, matching Cairo's u256 sqrt", () => {
    assert.equal(isqrt(0n), 0n);
    assert.equal(isqrt(1n), 1n);
    assert.equal(isqrt(2n), 1n);
    assert.equal(isqrt(16n), 4n);
    assert.equal(isqrt(17n), 4n);
    assert.equal(isqrt(10n ** 36n), 10n ** 18n);
});

test("price_bps matches the vectors the Cairo suite pins", () => {
    // From `even_book_prices_at_half` in cairo/src/pricing.cairo.
    assert.equal(priceBps(1000n, 1000n), 5000);
    assert.equal(priceBps(1000n, 3000n), 7500);
    assert.equal(priceBps(0n, 0n), 5000);
});

test("the two sides always price a coin, off by at most a bps of shared rounding", () => {
    for (const [yes, no] of [
        [1n, 1n],
        [1234n * ONE, 5678n * ONE],
        [7n, 999_999n],
        [10n ** 24n, 3n],
    ]) {
        const sum = priceBps(yes, no) + priceBps(no, yes);
        assert.ok(sum === 10_000 || sum === 9999, `sum was ${sum} for ${yes}/${no}`);
    }
});

test("a buy never shrinks the constant product, so the pool cannot be drained by trading", () => {
    for (const amount of [1n, 1000n, ONE, 50n * ONE]) {
        const { sharesOut, newBought, newOther } = buy(100n * ONE, 100n * ONE, amount);
        assert.ok(newBought * newOther >= 100n * ONE * (100n * ONE), "product shrank");
        assert.ok(newOther === 100n * ONE + amount, "other reserve must take the whole deposit");
        assert.ok(sharesOut > 0n, "a buy must mint shares");
    }
});

test("a buy then an immediate sell never returns more than went in", () => {
    for (const amount of [1000n, ONE, 10n * ONE]) {
        const bought = buy(100n * ONE, 100n * ONE, amount);
        const sold = sell(bought.newBought, bought.newOther, bought.sharesOut);
        assert.ok(sold.amountOut <= amount, `round trip printed money: ${sold.amountOut} > ${amount}`);
    }
});

test("buying a side only ever raises that side's price", () => {
    const before = priceBps(evenBook.rYes, evenBook.rNo);
    const { newBought, newOther } = buy(evenBook.rYes, evenBook.rNo, 20n * ONE);
    assert.ok(priceBps(newBought, newOther) > before);
});

test("sidesOf trades YES against NO and NO against YES", () => {
    const yes = sidesOf({ rYes: 1n, rNo: 2n }, 0);
    const no = sidesOf({ rYes: 1n, rNo: 2n }, 1);
    assert.deepEqual(yes, { rBought: 1n, rOther: 2n });
    assert.deepEqual(no, { rBought: 2n, rOther: 1n });
});

test("quoteOpen computes the notional, borrow and fee that do_open computes", () => {
    const quote = quoteOpen(evenBook, 0, 10n * ONE, 30_000); // 3x
    assert.equal(quote.notional, 30n * ONE);
    assert.equal(quote.borrowed, 20n * ONE);
    // 0.30% of notional to insurance.
    assert.equal(quote.fee, (30n * ONE * 30n) / 10_000n);
    assert.equal(quote.invested, quote.notional - quote.fee);
    assert.equal(quote.entryPriceBps, 5000);
    assert.ok(quote.priceAfterBps > quote.entryPriceBps, "an open must move the price it buys");
    assert.ok(quote.shares > 0n);
});

test("1x leverage borrows nothing", () => {
    const quote = quoteOpen(evenBook, 0, 5n * ONE, 10_000);
    assert.equal(quote.notional, 5n * ONE);
    assert.equal(quote.borrowed, 0n);
});

test("a just-opened position marks at a small loss, healthy, not liquidatable", () => {
    const quote = quoteOpen(evenBook, 0, 10n * ONE, 30_000);
    const after = buy(evenBook.rYes, evenBook.rNo, quote.invested);
    const book = { rYes: after.newBought, rNo: after.newOther };
    const position = { shares: quote.shares, margin: 10n * ONE, borrowed: quote.borrowed, state: "Open" };
    const mark = markPosition(book, 0, position);
    assert.ok(mark.equity > 0n, "equity must be positive right after opening");
    assert.ok(mark.equity < 10n * ONE, "the open fee and the spread cost the trader something");
    assert.ok(mark.pnl < 0n, "so P&L starts slightly negative");
    assert.ok(mark.healthBps > 800, `health ${mark.healthBps} should be above the floor`);
    assert.equal(mark.liquidatable, false);
});

test("a closed or empty position marks as nothing rather than throwing", () => {
    for (const state of ["None", "Closed", "Liquidated"]) {
        const mark = markPosition(evenBook, 0, { shares: 5n, margin: 1n, borrowed: 0n, state });
        assert.deepEqual(mark, { value: 0n, equity: 0n, healthBps: 0, pnl: 0n, liquidatable: false });
    }
    const zeroShares = markPosition(evenBook, 0, { shares: 0n, margin: 1n, borrowed: 0n, state: "Open" });
    assert.equal(zeroShares.liquidatable, false);
});

test("a crashed position marks liquidatable at or below the 8% floor", () => {
    // A thin book crushed against a 5x long: equity collapses below the maintenance margin.
    const quote = quoteOpen({ rYes: 10n * ONE, rNo: 10n * ONE }, 0, 4n * ONE, 50_000);
    const crashed = { rYes: 40n * ONE, rNo: 2n * ONE };
    const position = { shares: quote.shares, margin: 4n * ONE, borrowed: quote.borrowed, state: "Open" };
    const mark = markPosition(crashed, 0, position);
    assert.ok(mark.healthBps <= 800, `health ${mark.healthBps} should be at or below the floor`);
    assert.equal(mark.liquidatable, true);
});

test("mandateStatus fires a stop at or below and a take at or above and never on a zero band", () => {
    const stopOnly = { agentKey: "0xa9e", stopPriceBps: 6000, takePriceBps: 0 };
    const atStop = mandateStatus(evenBook, 0, stopOnly); // price 5000, stop 6000
    assert.equal(atStop.stopHit, true);
    assert.equal(atStop.firable, true);
    assert.equal(atStop.reason, "stop reached");

    const takeOnly = { agentKey: "0xa9e", stopPriceBps: 0, takePriceBps: 4000 };
    const atTake = mandateStatus(evenBook, 0, takeOnly); // price 5000, take 4000
    assert.equal(atTake.takeHit, true);
    assert.equal(atTake.firable, true);

    const outside = { agentKey: "0xa9e", stopPriceBps: 1000, takePriceBps: 9000 };
    const inBand = mandateStatus(evenBook, 0, outside);
    assert.equal(inBand.firable, false);
    assert.equal(inBand.reason, "price is inside the band, nothing to do");
});

test("a zeroed agent key is never firable, however the price sits", () => {
    const none = mandateStatus(evenBook, 0, { agentKey: "0x0", stopPriceBps: 9999, takePriceBps: 1 });
    assert.equal(none.hasAgent, false);
    assert.equal(none.firable, false);
    assert.equal(none.reason, "no mandate on this position");
});

test("the keeper reward is capped by the surplus the sale actually produced", () => {
    const notional = 100n * ONE;
    const position = { margin: 20n * ONE, borrowed: 80n * ONE };
    // Plenty of surplus: the reward is the full 1% of notional.
    const rich = keeperReward(position, { value: 90n * ONE });
    assert.equal(rich, (notional * 100n) / 10_000n);
    // Barely any surplus: the reward is what there is, never more.
    const thin = keeperReward(position, { value: 80n * ONE + 5n });
    assert.equal(thin, 5n);
    // Underwater: nothing to pay a keeper from.
    assert.equal(keeperReward(position, { value: 70n * ONE }), 0n);
});

test("formatStrk and parseStrk round-trip and parseStrk refuses junk", () => {
    assert.equal(formatStrk(ONE), "1");
    assert.equal(formatStrk(3n * ONE / 2n), "1.5");
    assert.equal(formatStrk(1n), "0");
    assert.equal(formatStrk(0n), "0");
    assert.equal(parseStrk("1.5"), 3n * ONE / 2n);
    assert.equal(parseStrk("0.0001"), 10n ** 14n);
    for (const junk of ["", ".", "abc", "-1", "1.2.3", "0"]) {
        assert.equal(parseStrk(junk), null, `parseStrk should refuse "${junk}"`);
    }
});
