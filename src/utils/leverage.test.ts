import { ec, num } from "starknet";
import { describe, expect, it } from "vitest";
import {
    type LevCoupon,
    type LevMarketView,
    type LevPosition,
    SIDE_NO,
    SIDE_YES,
    buy,
    closeIntoNoteCalldata,
    closeMessageHash,
    closeToAddressCalldata,
    isqrt,
    markPosition,
    newLevCoupon,
    openCalldata,
    priceBps,
    quoteOpen,
    sell,
    sidesOf,
} from "./leverage";

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
    /// the SDK asserts in its own suite. Three implementations, one number.
    it("agrees with the contract and the SDK, felt for felt", () => {
        expect(closeMessageHash(LEV, 7, SIDE_NO, "0x434f55504f4e", "0x0")).toBe(
            "0x1b63599a3692bd03b2fb7691332e685cffb4bb5217293a435bf23f2c4790e8e"
        );
    });
});

describe("calldata", () => {
    it("lays an open out as the Open variant of LeverageAction", () => {
        const c = coupon();
        expect(openCalldata(c)).toEqual([
            "0x0", "0x7", "0x1", c.positionKey, "0x1bc16d674ec80000", "0x7530", "0x2710",
        ]);
        expect(openCalldata(c, 6000).at(-1)).toBe("0x1770");
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
        expect(sharesOut > 1_000n).toBe(true);
        expect(newBought * newOther >= 10_000n * 10_000n).toBe(true);
        const { amountOut } = sell(newBought, newOther, sharesOut);
        expect(amountOut <= 1_000n).toBe(true);
    });
});

describe("quoteOpen and markPosition", () => {
    it("computes the notional, borrow and fee do_open would", () => {
        const q = quoteOpen(market(), SIDE_YES, 10n * ONE, 30_000);
        expect(q.notional).toBe(30n * ONE);
        expect(q.borrowed).toBe(20n * ONE);
        expect(q.fee).toBe((30n * ONE * 30n) / 10_000n);
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
        expect(mark.equity < 10n * ONE).toBe(true);
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
