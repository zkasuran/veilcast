import { describe, expect, it } from "vitest";
import { createDemoActivity, createDemoMarkets } from "./demoBoard";

const NOW = 1_750_000_000;

describe("demoBoard", () => {
    it("seeds a stable, non-empty board in every state", () => {
        const markets = createDemoMarkets(NOW);
        expect(markets.length).toBeGreaterThan(0);
        expect(markets.some((view) => view.state === "Open")).toBe(true);
        expect(markets.some((view) => view.state === "Resolved")).toBe(true);
        expect(markets.some((view) => view.state === "Void")).toBe(true);
        // Every market is a valid MarketView with a pot.
        for (const view of markets) {
            expect(view.volumes.length).toBe(view.labels.length);
            expect(view.pot).toBeGreaterThan(0n);
        }
    });

    it("is deterministic for a fixed clock", () => {
        const first = createDemoMarkets(NOW);
        const second = createDemoMarkets(NOW);
        expect(first).toEqual(second);
    });

    it("produces a demo activity stream with coupon keys, never addresses", () => {
        const events = createDemoActivity(NOW);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
            // Nothing on a demo event is a real Starknet address; bets carry a fresh coupon key only.
            expect(event.txHash).toMatch(/^0x[0-9a-f]/);
            if (event.kind === "bet") {
                expect(event.positionKey).toMatch(/^0x[0-9a-f]+$/);
            } else if (event.kind === "created") {
                expect(event.positionKey).toBeUndefined();
            }
        }
    });
});
