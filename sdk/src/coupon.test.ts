import { ec, num } from "starknet";
import { describe, expect, it } from "vitest";
import {
    type Coupon,
    betCalldata,
    claimIntoNoteCalldata,
    claimMessageHash,
    claimToAddressCalldata,
    newCoupon,
    openNotePlaceholder,
} from "./index.js";

const MARKET = "0x4d41524b4554";
const PRIVATE_KEY = "0x1234";
const ONE = 10n ** 18n;

function coupon(overrides: Partial<Coupon> = {}): Coupon {
    return {
        marketId: 7,
        outcome: 1,
        privateKey: PRIVATE_KEY,
        positionKey: ec.starkCurve.getStarkKey(PRIVATE_KEY),
        amount: (2n * ONE).toString(),
        createdAt: 0,
        ...overrides,
    };
}

describe("claimMessageHash", () => {
    /// The fixed vector the contract asserts in `test_claim_message_hash_matches_the_frontend` and
    /// the app asserts in its own suite. Three independent implementations, one number: if any of
    /// them drifts, a test fails here instead of every claim reverting on-chain.
    it("agrees with the contract and the app, felt for felt", () => {
        expect(claimMessageHash(MARKET, 7, 1, "0x434f55504f4e", "0x0")).toBe(
            "0x421e0ee22d66877400410f3d00e57cae3b41f27c631bb8315168ac53a23ddf6"
        );
    });
});

describe("calldata", () => {
    it("lays a bet out as the Bet variant of MarketAction", () => {
        const bet = coupon();
        expect(betCalldata(bet)).toEqual(["0x0", "0x7", "0x1", "0x1bc16d674ec80000", bet.positionKey]);
    });

    it("signs a note claim as bearer, at the note index it is given", () => {
        const bet = coupon();
        const signed = ec.starkCurve.sign(claimMessageHash(MARKET, 7, 1, bet.positionKey, "0x0"), PRIVATE_KEY);
        expect(claimIntoNoteCalldata(bet, MARKET, 0)).toEqual([
            "0x1", "0x7", "0x1", bet.positionKey, num.toHex(signed.r), num.toHex(signed.s), "0x0", "${openNoteIds[0]}",
        ]);
        expect(claimIntoNoteCalldata(bet, MARKET, 2).at(-1)).toBe("${openNoteIds[2]}");
        expect(openNotePlaceholder(3)).toBe("${openNoteIds[3]}");
    });

    it("binds an address claim to that address", () => {
        const bet = coupon();
        const signed = ec.starkCurve.sign(claimMessageHash(MARKET, 7, 1, bet.positionKey, "0xabc"), PRIVATE_KEY);
        expect(claimToAddressCalldata(bet, MARKET, "0xabc")).toEqual([
            "0x1", "0x7", "0x1", bet.positionKey, num.toHex(signed.r), num.toHex(signed.s), "0x1", "0xabc",
        ]);
    });
});

describe("newCoupon", () => {
    it("mints a fresh key whose public half is the position owner, unlinkable across bets", () => {
        const a = newCoupon(3, 0, ONE);
        const b = newCoupon(3, 0, ONE);
        expect(a.positionKey).toBe(ec.starkCurve.getStarkKey(a.privateKey));
        expect(a.amount).toBe(ONE.toString());
        expect(a.privateKey).not.toBe(b.privateKey);
    });
});
