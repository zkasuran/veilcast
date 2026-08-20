import { describe, expect, it } from "vitest";
import type { MarketView } from "./market";
import {
    closingSoon,
    isClaimable,
    portfolioTotals,
    positionPnl,
    positionsCsv,
    signedStrk,
} from "./portfolio";
import type { Coupon } from "./veilcast";

const ONE = 10n ** 18n;
const NOW = 1_000_000;

function coupon(overrides: Partial<Coupon> = {}): Coupon {
    return {
        marketId: 0,
        outcome: 0,
        privateKey: "0x1",
        positionKey: "0xkey",
        amount: ONE.toString(),
        createdAt: 0,
        ...overrides,
    };
}

function view(overrides: Partial<MarketView> = {}): MarketView {
    return {
        id: 0,
        question: "Will STRK win?",
        labels: ["Yes", "No"],
        volumes: [3n * ONE, ONE],
        pot: 4n * ONE,
        closeAt: NOW + 3600,
        createdAt: NOW - 3600,
        category: "Crypto",
        feeBps: 0,
        feeRecipient: "0x0",
        feeOwed: 0n,
        state: "Open",
        winningOutcome: 0,
        resolver: "0x123",
        ...overrides,
    };
}

describe("positionPnl", () => {
    it("values an open position at the current odds, and flags it as live", () => {
        // 1 STRK already on Yes of a 4 STRK pot: another STRK on Yes pays 5/4 * ... quote.
        const row = positionPnl(coupon(), view(), ONE, NOW);
        expect(row.valueIsLive).toBe(true);
        expect(row.status).toBe("live");
        // Value is the quote for the staked amount, so pnl is value - staked.
        expect(row.pnl).toBe(row.value - ONE);
    });

    it("values a won position at its settled payout, live no more", () => {
        const won = positionPnl(
            coupon({ amount: (3n * ONE).toString() }),
            view({ state: "Resolved", winningOutcome: 0 }),
            3n * ONE,
            NOW
        );
        // Whole 4 STRK pot to the 3 STRK winning side that this coupon is all of.
        expect(won.value).toBe(4n * ONE);
        expect(won.pnl).toBe(ONE);
        expect(won.valueIsLive).toBe(false);
        expect(won.status).toBe("won");
    });

    it("values a lost position at zero and a void at a full refund", () => {
        const lost = positionPnl(coupon({ outcome: 1 }), view({ state: "Resolved", winningOutcome: 0 }), ONE, NOW);
        expect(lost.value).toBe(0n);
        expect(lost.pnl).toBe(-ONE);

        const voided = positionPnl(coupon(), view({ state: "Void" }), ONE, NOW);
        expect(voided.value).toBe(ONE);
        expect(voided.pnl).toBe(0n);
    });

    it("still shows a collected position's worth rather than dropping it to zero", () => {
        const collected = positionPnl(
            coupon({ amount: (3n * ONE).toString(), claimedTx: "0xabc" }),
            view({ state: "Resolved", winningOutcome: 0 }),
            0n,
            NOW
        );
        expect(collected.claimed).toBe(true);
        expect(collected.stake).toBe(0n);
        expect(collected.value).toBe(4n * ONE);
        expect(collected.status).toBe("collected");
        expect(isClaimable(collected)).toBe(false);
    });
});

describe("portfolioTotals", () => {
    it("splits staked, value, at-risk and claimable the way a holder thinks about it", () => {
        const rows = [
            positionPnl(coupon({ marketId: 1 }), view({ id: 1, state: "Open" }), ONE, NOW),
            positionPnl(coupon({ marketId: 2 }), view({ id: 2, state: "Resolved", winningOutcome: 0 }), ONE, NOW),
            positionPnl(coupon({ marketId: 3, outcome: 1 }), view({ id: 3, state: "Resolved", winningOutcome: 0 }), ONE, NOW),
        ];
        const totals = portfolioTotals(rows);
        expect(totals.positions).toBe(3);
        expect(totals.staked).toBe(3n * ONE);
        // Only the open one is still at risk.
        expect(totals.atRisk).toBe(ONE);
        // The won one is claimable; the lost one is not.
        expect(totals.claimableCount).toBe(1);
        expect(totals.claimable).toBe(rows[1].value);
    });
});

describe("closingSoon", () => {
    it("catches open positions inside the window, soonest first, and nothing settled", () => {
        const rows = [
            positionPnl(coupon({ marketId: 1 }), view({ id: 1, state: "Open", closeAt: NOW + 7200 }), ONE, NOW),
            positionPnl(coupon({ marketId: 2 }), view({ id: 2, state: "Open", closeAt: NOW + 1800 }), ONE, NOW),
            positionPnl(coupon({ marketId: 3 }), view({ id: 3, state: "Open", closeAt: NOW + 200_000 }), ONE, NOW),
            positionPnl(coupon({ marketId: 4 }), view({ id: 4, state: "Resolved", winningOutcome: 0 }), ONE, NOW),
        ];
        const soon = closingSoon(rows, 24 * 3600, NOW);
        expect(soon.map((row) => row.coupon.marketId)).toEqual([2, 1]);
    });
});

describe("positionsCsv", () => {
    it("writes a header and a row per position, in STRK, with the txs and no key material beyond the public key", () => {
        const rows = [
            positionPnl(
                coupon({ marketId: 5, betTx: "0xbet", claimedTx: "0xclaim", amount: (3n * ONE).toString() }),
                view({ id: 5, question: "A, tricky, question", state: "Resolved", winningOutcome: 0 }),
                0n,
                NOW
            ),
        ];
        const csv = positionsCsv(rows);
        const [header, line] = csv.split("\n");
        expect(header.startsWith("market_id,question,outcome,status")).toBe(true);
        // The comma-laden question is quoted so it stays one cell.
        expect(line).toContain('"A, tricky, question"');
        expect(line).toContain("0xbet");
        expect(line).toContain("0xclaim");
        expect(line).toContain("settled");
        expect(line).not.toContain("0x1"); // never the private key
    });

    it("signs the pnl column so a gain and a loss read apart", () => {
        expect(signedStrk(ONE / 2n)).toBe("+0.5");
        expect(signedStrk(-ONE / 2n)).toBe("-0.5");
        expect(signedStrk(0n)).toBe("+0");
    });
});
