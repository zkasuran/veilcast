import { hash, num, shortString } from "starknet";
import { describe, expect, it } from "vitest";
import { type RawEvent, decodeEvents, oddsSeries } from "./events";

const ONE_STRK = 10n ** 18n;

function rawEvent(name: string, keys: string[], data: string[], blockNumber = 100): RawEvent {
    return {
        keys: [num.toHex(hash.getSelectorFromName(name)), ...keys],
        data,
        block_number: blockNumber,
        transaction_hash: `0xtx${blockNumber}`,
    };
}

/// A bet on `outcome` of market 3, carrying that outcome's running total the way the contract emits
/// it: keys are the market, the outcome and the coupon, data is the stake and the new volume.
function bet(outcome: number, amount: bigint, volume: bigint, block = 100): RawEvent {
    return rawEvent(
        "BetPlaced",
        ["0x3", num.toHex(outcome), "0xc0up0n"],
        [num.toHex(amount), num.toHex(volume)],
        block
    );
}

describe("decodeEvents", () => {
    it("reads a bet, which carries an amount, an outcome and a key but no address", () => {
        const [event] = decodeEvents([bet(1, 2n * ONE_STRK, 5n * ONE_STRK, 42)]);
        expect(event).toEqual({
            kind: "bet",
            marketId: 3,
            outcome: 1,
            positionKey: "0xc0up0n",
            amount: 2n * ONE_STRK,
            outcomeVolume: 5n * ONE_STRK,
            blockNumber: 42,
            txHash: "0xtx42",
        });
    });

    it("reads the settlement events", () => {
        const resolved = decodeEvents([
            rawEvent("MarketResolved", ["0x3"], ["0x1", num.toHex(6n * ONE_STRK)]),
        ])[0];
        expect(resolved.kind).toBe("resolved");
        expect(resolved.outcome).toBe(1);
        expect(resolved.amount).toBe(6n * ONE_STRK);

        const voided = decodeEvents([rawEvent("MarketVoided", ["0x3"], [])])[0];
        expect(voided.kind).toBe("void");
        expect(voided.marketId).toBe(3);

        const claimed = decodeEvents([
            rawEvent("PayoutClaimed", ["0x3", "0xc0up0n"], [num.toHex(4n * ONE_STRK)]),
        ])[0];
        expect(claimed.kind).toBe("claimed");
        expect(claimed.positionKey).toBe("0xc0up0n");
        expect(claimed.amount).toBe(4n * ONE_STRK);
    });

    it("reads an opening, whose second key is the section it was filed under", () => {
        const created = decodeEvents([
            rawEvent(
                "MarketCreated",
                ["0x3", shortString.encodeShortString("Crypto")],
                ["0x123", "0x3e8", "0x2"]
            ),
        ])[0];
        expect(created.kind).toBe("created");
        expect(created.category).toBe(shortString.encodeShortString("Crypto"));
    });

    it("ignores an event this app does not publish rather than failing on it", () => {
        expect(decodeEvents([rawEvent("SomethingElse", ["0x3"], [])])).toEqual([]);
        expect(decodeEvents([{ keys: [], data: [] }])).toEqual([]);
    });
});

describe("oddsSeries", () => {
    it("rebuilds the odds from the volumes the events carry", () => {
        // 3 STRK on Yes, then 1 on No, then 1 more on Yes: 4 of a 5 STRK pot on Yes.
        const points = oddsSeries(
            decodeEvents([
                bet(0, 3n * ONE_STRK, 3n * ONE_STRK, 10),
                bet(1, ONE_STRK, ONE_STRK, 11),
                bet(0, ONE_STRK, 4n * ONE_STRK, 12),
            ]),
            2
        );

        expect(points).toHaveLength(3);
        expect(points[0].probabilities).toEqual([1, 0]);
        expect(points[0].pot).toBe(3n * ONE_STRK);
        expect(points[1].probabilities).toEqual([0.75, 0.25]);
        expect(points[2].probabilities).toEqual([0.8, 0.2]);
        expect(points[2].volumes).toEqual([4n * ONE_STRK, ONE_STRK]);
        expect(points[2].pot).toBe(5n * ONE_STRK);
        // The x axis is the market's own sequence of bets, numbered from one.
        expect(points.map((point) => point.index)).toEqual([1, 2, 3]);
        expect(points.map((point) => point.blockNumber)).toEqual([10, 11, 12]);
    });

    it("counts only bets, and only on outcomes the market has", () => {
        const events = decodeEvents([
            rawEvent("MarketCreated", ["0x3", "0x0"], ["0x123", "0x3e8", "0x2"], 9),
            bet(0, ONE_STRK, ONE_STRK, 10),
            bet(7, ONE_STRK, ONE_STRK, 11),
            rawEvent("MarketResolved", ["0x3"], ["0x0", num.toHex(ONE_STRK)], 12),
        ]);
        const points = oddsSeries(events, 2);
        expect(points).toHaveLength(1);
        expect(points[0].probabilities).toEqual([1, 0]);
    });

    it("has nothing to draw before the first bet", () => {
        expect(oddsSeries([], 2)).toEqual([]);
    });
});
