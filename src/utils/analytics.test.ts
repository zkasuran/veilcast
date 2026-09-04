import { describe, expect, it } from "vitest";
import type { MarketView } from "./market";
import { bestMarketAnalysis, boardAnalytics, deriveAnalytics } from "./analytics";

const STRK_UNIT = 10n ** 18n;
const NOW = 1_750_000_000;

function view(overrides: Partial<MarketView> = {}): MarketView {
    return {
        id: 1,
        question: "Will the outcome happen?",
        labels: ["Yes", "No"],
        volumes: [300n * STRK_UNIT, 200n * STRK_UNIT],
        pot: 500n * STRK_UNIT,
        closeAt: NOW + 7 * 24 * 3600,
        createdAt: NOW - 3600,
        category: "Crypto",
        feeBps: 100,
        feeRecipient: "0x1",
        feeOwed: 0n,
        state: "Open",
        winningOutcome: 0,
        resolver: "0x2",
        ...overrides,
    };
}

describe("deriveAnalytics", () => {
    it("reads the strongest liquid outcome on an open market", () => {
        const read = bestMarketAnalysis(view(), NOW);
        expect(read).toBeDefined();
        expect(read!.label).toBe("Yes");
        expect(read!.implied).toBeGreaterThan(0.5);
        expect(read!.payout).toBeGreaterThan(1);
        expect(read!.lenses).toHaveLength(5);
        expect(read!.score).toBeGreaterThanOrEqual(0);
        expect(read!.score).toBeLessThanOrEqual(100);
    });

    it("skips markets that are not taking bets", () => {
        expect(bestMarketAnalysis(view({ state: "Resolved" }), NOW)).toBeUndefined();
        expect(bestMarketAnalysis(view({ closeAt: NOW - 1 }), NOW)).toBeUndefined();
    });

    it("reports no signal on an empty book", () => {
        const read = bestMarketAnalysis(view({ volumes: [0n, 0n], pot: 0n }), NOW);
        expect(read!.verdict).toBe("No signal");
    });

    it("sorts the board into one line per market", () => {
        const two = [
            view({ id: 1, volumes: [900n * STRK_UNIT, 100n * STRK_UNIT], pot: STRK_UNIT * 1000n }),
            view({ id: 2, volumes: [400n * STRK_UNIT, 400n * STRK_UNIT], pot: 800n * STRK_UNIT }),
        ];
        const reads = deriveAnalytics(two, NOW);
        expect(reads).toHaveLength(2);
        // The lopsided one should rank above the even one.
        expect(reads[0].marketId).toBe(1);
    });

    it("aggregates the board", () => {
        const reads = deriveAnalytics([view()], NOW);
        const meta = boardAnalytics(reads);
        expect(meta.openMarkets).toBe(1);
        expect(meta.busiest?.marketId).toBe(1);
        expect(meta.totalPot).toBe(500n * STRK_UNIT);
        expect(meta.updatedAt).toBeGreaterThan(0);
    });
});
