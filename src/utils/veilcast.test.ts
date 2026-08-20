import { ec, num } from "starknet";
import { beforeEach, describe, expect, it } from "vitest";
import {
    type Coupon,
    batchClaimIntoNotesActions,
    betActions,
    betCalldata,
    claimIntoNoteActions,
    claimIntoNoteCalldata,
    claimMessageHash,
    claimToAddressCalldata,
    claimToWalletActions,
    couponsBackup,
    formatStrk,
    formatTimeLeft,
    impliedProbability,
    importCoupons,
    loadCoupons,
    newCoupon,
    openNotePlaceholder,
    parseStrk,
    payoutMultiple,
    saveCoupon,
} from "./veilcast";

const TOKEN = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
// 'MARKET' as a short string: the same literal the Cairo test signs over.
const MARKET = "0x4d41524b4554";
const PRIVATE_KEY = "0x1234";
const ONE_STRK = 10n ** 18n;

function coupon(overrides: Partial<Coupon> = {}): Coupon {
    return {
        marketId: 7,
        outcome: 1,
        privateKey: PRIVATE_KEY,
        positionKey: ec.starkCurve.getStarkKey(PRIVATE_KEY),
        amount: (2n * ONE_STRK).toString(),
        createdAt: 0,
        ...overrides,
    };
}

/// Signs the message the calldata under test should be carrying. Stark signing is deterministic, so
/// a matching (r, s) proves the calldata signed that exact message and nothing else.
function signature(target: string, bet: Coupon = coupon()): string[] {
    const signed = ec.starkCurve.sign(
        claimMessageHash(MARKET, bet.marketId, bet.outcome, bet.positionKey, target),
        bet.privateKey
    );
    return [num.toHex(signed.r), num.toHex(signed.s)];
}
describe("claimMessageHash", () => {
    /// The fixed vector `test_claim_message_hash_matches_the_frontend` asserts in Cairo. If Poseidon
    /// here and Poseidon there ever disagree, one of the two tests fails instead of every claim
    /// silently reverting on-chain.
    it("agrees with the contract felt for felt", () => {
        expect(claimMessageHash(MARKET, 7, 1, "0x434f55504f4e", "0x0")).toBe(
            "0x421e0ee22d66877400410f3d00e57cae3b41f27c631bb8315168ac53a23ddf6"
        );
    });

    it("changes when anything the claim is about changes", () => {
        const base = claimMessageHash(MARKET, 7, 1, "0x434f55504f4e", "0x0");
        expect(claimMessageHash(MARKET, 8, 1, "0x434f55504f4e", "0x0")).not.toBe(base);
        expect(claimMessageHash(MARKET, 7, 0, "0x434f55504f4e", "0x0")).not.toBe(base);
        expect(claimMessageHash(MARKET, 7, 1, "0x434f55504f4e", "0x999")).not.toBe(base);
        expect(claimMessageHash("0x999", 7, 1, "0x434f55504f4e", "0x0")).not.toBe(base);
    });
});

describe("calldata", () => {
    it("lays a bet out as the Bet variant of MarketAction", () => {
        const bet = coupon();
        expect(betCalldata(bet)).toEqual(["0x0", "0x7", "0x1", "0x1bc16d674ec80000", bet.positionKey]);
    });

    it("signs a claim into an open note as bearer, with the wallet's note placeholder", () => {
        const bet = coupon();
        const [r, s] = signature("0x0", bet);
        expect(claimIntoNoteCalldata(bet, MARKET)).toEqual([
            "0x1", "0x7", "0x1", bet.positionKey, r, s, "0x0", "${openNoteIds[0]}",
        ]);
    });

    it("binds a claim to an address to that address", () => {
        const bet = coupon();
        const recipient = "0xabc";
        const [r, s] = signature(recipient, bet);
        expect(claimToAddressCalldata(bet, MARKET, recipient)).toEqual([
            "0x1", "0x7", "0x1", bet.positionKey, r, s, "0x1", recipient,
        ]);
        // A bearer signature is not the same authorization, which is what stops a relayer from
        // pointing a note claim at an address of its own.
        expect(signature("0x0", bet)).not.toEqual([r, s]);
    });
});
describe("pool action lists", () => {
    it("withdraws the stake into the market, then books it", () => {
        const bet = coupon();
        expect(betActions(TOKEN, MARKET, bet)).toEqual([
            { type: "withdraw", token: TOKEN, amount: "0x1bc16d674ec80000", recipient: MARKET },
            { type: "invoke", contract: MARKET, calldata: betCalldata(bet) },
        ]);
    });

    it("creates the open note before the invoke that fills it", () => {
        const bet = coupon();
        const actions = claimIntoNoteActions(TOKEN, MARKET, bet, "0xdef");
        // The pool applies actions in order and rejects a transaction that leaves an open note
        // undeposited, so this order is the difference between a payout and a revert.
        expect(actions.map((action) => action.type)).toEqual(["transfer", "invoke"]);
        expect(actions[0]).toEqual({ type: "transfer", token: TOKEN, amount: "OPEN", recipient: "0xdef" });
        expect(actions[1]).toEqual({
            type: "invoke",
            contract: MARKET,
            calldata: claimIntoNoteCalldata(bet, MARKET),
        });
    });

    it("takes a public payout in one invoke, with no note to fill", () => {
        const bet = coupon();
        expect(claimToWalletActions(MARKET, bet, "0xabc")).toEqual([
            { type: "invoke", contract: MARKET, calldata: claimToAddressCalldata(bet, MARKET, "0xabc") },
        ]);
    });

    it("collects a batch as all the open notes first, then all the claims", () => {
        const a = coupon({ marketId: 1, outcome: 0 });
        const b = coupon({ marketId: 2, outcome: 1, privateKey: "0x5678", positionKey: ec.starkCurve.getStarkKey("0x5678") });
        const actions = batchClaimIntoNotesActions(TOKEN, MARKET, [a, b], "0xdef");

        // Two opens, then two invokes: every note exists before the invoke that fills it, which is
        // what the pool requires.
        expect(actions.map((action) => action.type)).toEqual(["transfer", "transfer", "invoke", "invoke"]);
        expect(actions[0]).toEqual({ type: "transfer", token: TOKEN, amount: "OPEN", recipient: "0xdef" });
        // Claim i fills note i, so the placeholders line up with the transfer order.
        expect((actions[2] as { calldata: string[] }).calldata.at(-1)).toBe("${openNoteIds[0]}");
        expect((actions[3] as { calldata: string[] }).calldata.at(-1)).toBe("${openNoteIds[1]}");
        expect((actions[2] as { calldata: string[] }).calldata).toEqual(claimIntoNoteCalldata(a, MARKET, 0));
        expect((actions[3] as { calldata: string[] }).calldata).toEqual(claimIntoNoteCalldata(b, MARKET, 1));
    });

    it("makes a lone claim the one-item case of a batch", () => {
        const bet = coupon();
        expect(claimIntoNoteActions(TOKEN, MARKET, bet, "0xdef")).toEqual(
            batchClaimIntoNotesActions(TOKEN, MARKET, [bet], "0xdef")
        );
        expect(openNotePlaceholder(0)).toBe("${openNoteIds[0]}");
        expect(openNotePlaceholder(3)).toBe("${openNoteIds[3]}");
    });
});
// __T5__


describe("amounts", () => {
    it("formats what a bettor recognises", () => {
        expect(formatStrk(4_500_000_000_000_000_000n)).toBe("4.5");
        expect(formatStrk(ONE_STRK)).toBe("1");
        expect(formatStrk(0n)).toBe("0");
        expect(formatStrk(1_000_000_000_000_000n)).toBe("0.001");
    });

    it("parses what a bettor types and refuses the rest", () => {
        expect(parseStrk("1.5")).toBe(1_500_000_000_000_000_000n);
        expect(parseStrk(" 2 ")).toBe(2n * ONE_STRK);
        expect(parseStrk(".5")).toBe(500_000_000_000_000_000n);
        expect(parseStrk("0")).toBeNull();
        expect(parseStrk("")).toBeNull();
        expect(parseStrk("-1")).toBeNull();
        expect(parseStrk("1e18")).toBeNull();
        expect(parseStrk("1.1234567890123456789")).toBeNull();
    });
});
describe("odds", () => {
    it("reads an implied probability off the public volume", () => {
        expect(impliedProbability(5n * ONE_STRK, 8n * ONE_STRK, 2)).toBeCloseTo(0.625);
        // An empty book has no opinion, so it splits evenly rather than reading as zero.
        expect(impliedProbability(0n, 0n, 2)).toBe(0.5);
        expect(impliedProbability(0n, 0n, 4)).toBe(0.25);
    });

    it("quotes the same multiple the contract would pay", () => {
        // 3 STRK on Yes, 1 on No: one more STRK on Yes splits a 5 STRK pot over 4 STRK of Yes.
        expect(payoutMultiple(3n * ONE_STRK, 4n * ONE_STRK, ONE_STRK)).toBeCloseTo(1.25);
        // The thin side pays more: the same pot over 2 STRK of No.
        expect(payoutMultiple(ONE_STRK, 4n * ONE_STRK, ONE_STRK)).toBeCloseTo(2.5);
        // On an empty book a stake can only ever win itself back.
        expect(payoutMultiple(0n, 0n, ONE_STRK)).toBeCloseTo(1);
    });
});

describe("coupons in the browser", () => {
    beforeEach(() => {
        const store = new Map<string, string>();
        (globalThis as { window?: unknown }).window = {
            localStorage: {
                getItem: (key: string) => store.get(key) ?? null,
                setItem: (key: string, value: string) => void store.set(key, value),
            },
        };
    });

    it("mints a coupon whose public key is the position's owner", () => {
        const bet = newCoupon(3, 1, 2n * ONE_STRK);
        expect(bet.positionKey).toBe(ec.starkCurve.getStarkKey(bet.privateKey));
        expect(bet.amount).toBe((2n * ONE_STRK).toString());
        // Two bets never share a key, so nothing on-chain links them.
        expect(newCoupon(3, 1, 2n * ONE_STRK).privateKey).not.toBe(bet.privateKey);
    });

    it("restores a backup without duplicating what is already here", () => {
        saveCoupon(coupon());
        const backup = couponsBackup();
        expect(importCoupons(backup)).toEqual({ added: 0, total: 1 });
        expect(importCoupons(JSON.stringify({ version: 1, coupons: [coupon({ positionKey: "0x99" })] })))
            .toEqual({ added: 1, total: 2 });
        expect(loadCoupons()).toHaveLength(2);
    });

    it("refuses anything that is not a coupon backup", () => {
        expect(importCoupons("not json")).toBeNull();
        expect(importCoupons("{}")).toBeNull();
        expect(importCoupons(JSON.stringify({ coupons: [{ privateKey: "0x1" }] }))).toBeNull();
    });
});

describe("formatTimeLeft", () => {
    it("stays coarse, because the close is a block timestamp", () => {
        expect(formatTimeLeft(1000, 1000)).toBe("closed");
        expect(formatTimeLeft(1000, 2000)).toBe("closed");
        expect(formatTimeLeft(400_000, 0)).toBe("4d 15h");
        expect(formatTimeLeft(8100, 0)).toBe("2h 15m");
        expect(formatTimeLeft(540, 0)).toBe("9m");
        expect(formatTimeLeft(5, 0)).toBe("1m");
    });
});
