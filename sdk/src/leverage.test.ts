import { ec, num } from "starknet";
import { describe, expect, it } from "vitest";
import {
    type LevCoupon,
    type Mandate,
    type LevMarketView,
    type LevPosition,
    SIDE_NO,
    SIDE_YES,
    agentCloseCalldata,
    buy,
    closeIntoNoteCalldata,
    closeMessageHash,
    closeToAddressCalldata,
    isqrt,
    mandate,
    mandateStatus,
    markPosition,
    newLevCoupon,
    noMandate,
    openCalldata,
    priceBps,
    quoteOpen,
    sell,
    sidesOf,
} from "./index.js";

const LEV = "0x4c4556"; // "LEV"
const PRIVATE_KEY = "0x1234";
const ONE = 10n ** 18n;

function coupon(overrides: Partial<LevCoupon> = {}): LevCoupon {
    return {
        marketId: 7,
        side: SIDE_NO,
        privateKey: PRIVATE_KEY,
        positionKey: ec.starkCurve.getStarkKey(PRIVATE_KEY),
        margin: (2n * ONE).toString(),
        leverageBps: 30_000,
        createdAt: 0,
        ...overrides,
    };
}

function market(overrides: Partial<LevMarketView> = {}): LevMarketView {
    return {
        id: 0,
        resolver: "0x1",
        closeAt: 9_999_999_999,
        createdAt: 0,
        rYes: 100n * ONE,
        rNo: 100n * ONE,
        state: "Open",
        winningSide: SIDE_YES,
        liquidity: 100n * ONE,
        borrowedYes: 0n,
        borrowedNo: 0n,
        ...overrides,
    };
}
describe("closeMessageHash", () => {
    /// The fixed vector the contract asserts in `test_close_message_hash_matches_the_frontend` and
    /// the app asserts in its own suite. Three implementations, one number: if any drifts, a test
    /// fails here instead of every close reverting on-chain with a bad signature.
    it("agrees with the contract and the app, felt for felt", () => {
        expect(closeMessageHash(LEV, 7, SIDE_NO, "0x434f55504f4e", "0x0")).toBe(
            "0x1b63599a3692bd03b2fb7691332e685cffb4bb5217293a435bf23f2c4790e8e"
        );
    });
});

describe("calldata", () => {
    it("lays an open out as the Open variant of LeverageAction", () => {
        const c = coupon();
        // Eleven felts now: the seven position fields plus the four mandate fields, zeroed when the
        // position is self-managed.
        expect(openCalldata(c)).toEqual([
            "0x0", "0x7", "0x1", c.positionKey, "0x1bc16d674ec80000", "0x7530", "0x2710",
            "0x0", "0x0", "0x0", "0x0",
        ]);
        // A tighter slippage cap rides in the last slot.
        expect(openCalldata(c, 6000)[6]).toBe("0x1770");
    });

    it("signs a note close as bearer, at the note index it is given", () => {
        const c = coupon();
        const signed = ec.starkCurve.sign(closeMessageHash(LEV, 7, SIDE_NO, c.positionKey, "0x0"), PRIVATE_KEY);
        expect(closeIntoNoteCalldata(c, LEV, 0)).toEqual([
            "0x1", "0x7", "0x1", c.positionKey, num.toHex(signed.r), num.toHex(signed.s), "0x0", "${openNoteIds[0]}",
        ]);
        expect(closeIntoNoteCalldata(c, LEV, 2).at(-1)).toBe("${openNoteIds[2]}");
    });

    it("binds an address close to that address", () => {
        const c = coupon();
        const signed = ec.starkCurve.sign(closeMessageHash(LEV, 7, SIDE_NO, c.positionKey, "0xabc"), PRIVATE_KEY);
        expect(closeToAddressCalldata(c, LEV, "0xabc")).toEqual([
            "0x1", "0x7", "0x1", c.positionKey, num.toHex(signed.r), num.toHex(signed.s), "0x1", "0xabc",
        ]);
    });
});
describe("pricing mirrors the contract", () => {
    it("takes a floor integer square root", () => {
        expect(isqrt(0n)).toBe(0n);
        expect(isqrt(2n)).toBe(1n);
        expect(isqrt(16n)).toBe(4n);
        expect(isqrt(17n)).toBe(4n);
    });

    it("prices a book the way pricing::price_bps does", () => {
        // The same numbers the Cairo suite pins in `even_book_prices_at_half`.
        expect(priceBps(1000n, 1000n)).toBe(5000);
        expect(priceBps(1000n, 3000n)).toBe(7500);
        expect(priceBps(0n, 0n)).toBe(5000);
    });

    it("keeps the two sides summing to a coin", () => {
        const sum = priceBps(1234n * ONE, 5678n * ONE) + priceBps(5678n * ONE, 1234n * ONE);
        expect(sum === 10_000 || sum === 9_999).toBe(true);
    });

    it("grows the product on a buy and prints no money on a round-trip", () => {
        const { sharesOut, newBought, newOther } = buy(10_000n, 10_000n, 1_000n);
        expect(sharesOut > 1_000n).toBe(true); // price below a coin, so more shares than collateral
        expect(newBought * newOther >= 10_000n * 10_000n).toBe(true);
        const { amountOut } = sell(newBought, newOther, sharesOut);
        expect(amountOut <= 1_000n).toBe(true);
    });
});

describe("quoteOpen and markPosition", () => {
    it("computes the notional, borrow and fee do_open would", () => {
        const q = quoteOpen(market(), SIDE_YES, 10n * ONE, 30_000); // 3x
        expect(q.notional).toBe(30n * ONE);
        expect(q.borrowed).toBe(20n * ONE);
        expect(q.fee).toBe((30n * ONE * 30n) / 10_000n); // 0.30% of notional
        expect(q.invested).toBe(q.notional - q.fee);
        expect(q.shares > 0n).toBe(true);
        expect(q.priceAfterBps > q.entryPriceBps).toBe(true);
    });

    it("marks a just-opened position at a small loss, healthy, not liquidatable", () => {
        const base = market();
        const q = quoteOpen(base, SIDE_YES, 10n * ONE, 30_000);
        const { rBought, rOther } = sidesOf(base, SIDE_YES);
        const after = buy(rBought, rOther, q.invested);
        const opened = market({ rYes: after.newBought, rNo: after.newOther });
        const position: LevPosition = { shares: q.shares, margin: 10n * ONE, borrowed: q.borrowed, state: "Open" };
        const mark = markPosition(opened, SIDE_YES, position);
        expect(mark.equity > 0n).toBe(true);
        expect(mark.equity < 10n * ONE).toBe(true); // the open fee and round-trip cost the trader
        expect(mark.pnl < 0n).toBe(true);
        expect(mark.healthBps > 800).toBe(true);
        expect(mark.liquidatable).toBe(false);
    });
});

describe("newLevCoupon", () => {
    it("mints a fresh key whose public half owns the position, unlinkable across opens", () => {
        const a = newLevCoupon(3, SIDE_YES, ONE, 20_000);
        const b = newLevCoupon(3, SIDE_YES, ONE, 20_000);
        expect(a.positionKey).toBe(ec.starkCurve.getStarkKey(a.privateKey));
        expect(a.margin).toBe(ONE.toString());
        expect(a.leverageBps).toBe(20_000);
        expect(a.privateKey).not.toBe(b.privateKey);
    });
});

describe("Mandate", () => {
    /// The security claim, asserted in TypeScript exactly as the Cairo suite asserts it: a malformed
    /// authority is refused before it can cost gas and a well-formed one pins its target.
    it("refuses every malformed authority the contract refuses", () => {
        expect(() => mandate({ agentKey: "0x0", stopPriceBps: 1, payoutTarget: "0xbeef" })).toThrow(
            /needs an agent key/
        );
        expect(() => mandate({ agentKey: "0xa9e", stopPriceBps: 1, payoutTarget: "0x0" })).toThrow(
            /must pin a payout address/
        );
        // No band at all is an unconditional authority, which the contract rejects as BAD_MANDATE.
        expect(() => mandate({ agentKey: "0xa9e", payoutTarget: "0xbeef" })).toThrow(/must grant a stop or a take/);
        expect(() => mandate({ agentKey: "0xa9e", stopPriceBps: 10_001, payoutTarget: "0xbeef" })).toThrow(
            /stopPriceBps must be an integer/
        );
    });

    it("accepts a one-sided band, because the other half is opt-out", () => {
        expect(mandate({ agentKey: "0xa9e", stopPriceBps: 4000, payoutTarget: "0xbeef" }).takePriceBps).toBe(0);
        expect(mandate({ agentKey: "0xa9e", takePriceBps: 8000, payoutTarget: "0xbeef" }).stopPriceBps).toBe(0);
    });

    it("puts the whole mandate inline in the open calldata", () => {
        const granted = mandate({ agentKey: "0xa9e", stopPriceBps: 4000, takePriceBps: 8000, payoutTarget: "0xbeef" });
        const calldata = openCalldata(coupon(), 6000, granted);
        expect(calldata).toHaveLength(11);
        expect(calldata.slice(-4)).toEqual(["0xa9e", "0xfa0", "0x1f40", "0xbeef"]);
    });

    it("writes a zeroed mandate for a self-managed position, which no agent can fire", () => {
        expect(openCalldata(coupon()).slice(-4)).toEqual(["0x0", "0x0", "0x0", "0x0"]);
        expect(noMandate()).toEqual({ agentKey: "0x0", stopPriceBps: 0, takePriceBps: 0, payoutTarget: "0x0" });
    });

    it("builds an agent close that names no target and no terms", () => {
        const calldata = agentCloseCalldata(LEV, 7, SIDE_YES, "0xdead", PRIVATE_KEY, "0xbeef");
        // [2, market, side, key, r, s]. Six felts: the agent chose none of the terms.
        expect(calldata).toHaveLength(6);
        expect(calldata[0]).toBe("0x2");
        const signed = ec.starkCurve.sign(closeMessageHash(LEV, 7, SIDE_YES, "0xdead", "0xbeef"), PRIVATE_KEY);
        expect(calldata[4]).toBe(num.toHex(signed.r));
    });

    it("signs over the pinned target, so a different target is a different signature", () => {
        const pinned = agentCloseCalldata(LEV, 7, SIDE_YES, "0xdead", PRIVATE_KEY, "0xbeef");
        const elsewhere = agentCloseCalldata(LEV, 7, SIDE_YES, "0xdead", PRIVATE_KEY, "0xfeed");
        // Both are well-formed. Only the one over the STORED target verifies on-chain, which is why an
        // agent cannot redirect a payout however it builds its calldata.
        expect(pinned[4]).not.toBe(elsewhere[4]);
    });

    it("reports whether a band is met, matching do_agent_close", () => {
        const book = market();
        const stopOnly: Mandate = { agentKey: "0xa9e", stopPriceBps: 6000, takePriceBps: 0, payoutTarget: "0xbeef" };
        const atStop = mandateStatus(book, SIDE_YES, stopOnly);
        expect(atStop.priceBps).toBe(5000);
        expect(atStop.stopHit).toBe(true);
        expect(atStop.firable).toBe(true);

        const inside: Mandate = { agentKey: "0xa9e", stopPriceBps: 1000, takePriceBps: 9000, payoutTarget: "0xbeef" };
        expect(mandateStatus(book, SIDE_YES, inside).firable).toBe(false);
        expect(mandateStatus(book, SIDE_YES, inside).reason).toBe("price is inside the band, nothing to do");

        const none: Mandate = { agentKey: "0x0", stopPriceBps: 9999, takePriceBps: 1, payoutTarget: "0x0" };
        expect(mandateStatus(book, SIDE_YES, none).firable).toBe(false);
        expect(mandateStatus(book, SIDE_YES, none).reason).toBe("no mandate on this position");
    });
});
