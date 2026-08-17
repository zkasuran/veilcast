import { shortString } from "starknet";
import { describe, expect, it } from "vitest";
import {
    OUTCOME_AT_OR_ABOVE,
    OUTCOME_BELOW,
    PAIRS,
    decodePriceQuestion,
    formatPrice,
    medianAgeMinutes,
    openPriceMarketCall,
    parseThreshold,
    settleCall,
} from "./resolver";

const RESOLVER = "0x5245534f4c56455f52";

describe("resolver calls", () => {
    it("encodes open_price_market with the pair as a short string", () => {
        expect(
            openPriceMarketCall(
                RESOLVER,
                "Will STRK close above 1 USD?",
                "Yes",
                "No",
                1000,
                "Crypto",
                "STRK/USD",
                100_000_000n
            )
        ).toEqual({
            contractAddress: RESOLVER,
            entrypoint: "open_price_market",
            calldata: [
                // the question, then a label per side, each a ByteArray
                "0", "9205538097822543379981534287168375851077269384910981464042195076159", "28",
                "0", "5858675", "3",
                "0", "20079", "2",
                "1000",
                // 'Crypto', then 'STRK/USD' as felts, then the threshold at the feed's 8 decimals
                "74158942745711",
                "6004514686061859652",
                "100000000",
            ],
        });
    });

    it("encodes settle, which carries nothing but the market id", () => {
        expect(settleCall(RESOLVER, 7)).toEqual({
            contractAddress: RESOLVER,
            entrypoint: "settle",
            calldata: ["7"],
        });
    });

    it("fixes which outcome is which, so no market can be wired the other way round", () => {
        expect([OUTCOME_AT_OR_ABOVE, OUTCOME_BELOW]).toEqual([0, 1]);
        expect(PAIRS.every((pair) => pair.decimals === 8)).toBe(true);
    });
});

describe("prices", () => {
    it("parses a threshold into the feed's own units", () => {
        expect(parseThreshold("1", 8)).toBe(100_000_000n);
        expect(parseThreshold("0.0229", 8)).toBe(2_290_000n);
        expect(parseThreshold(" 63199.0341 ", 8)).toBe(6_319_903_410_000n);
        expect(parseThreshold("0", 8)).toBeNull();
        expect(parseThreshold("", 8)).toBeNull();
        // More precision than the feed carries is a rounding decision this cannot make.
        expect(parseThreshold("1.123456789", 8)).toBeNull();
        expect(parseThreshold("1e8", 8)).toBeNull();
    });

    it("formats a price the way a price is written", () => {
        expect(formatPrice(2_290_000n, 8)).toBe("0.0229");
        expect(formatPrice(100_000_000n, 8)).toBe("1");
        expect(formatPrice(6_319_903_410_000n, 8)).toBe("63199.0341");
        expect(formatPrice(0n, 8)).toBe("0");
    });

    it("reads a bound question back, and knows when there is none", () => {
        const pairId = BigInt(shortString.encodeShortString("STRK/USD"));
        expect(decodePriceQuestion({ pair_id: pairId, threshold: 100_000_000n })).toEqual({
            ticker: "STRK/USD",
            threshold: 100_000_000n,
        });
        // A market this resolver never opened reads back as a zero pair, not as a real question.
        expect(decodePriceQuestion({ pair_id: 0n, threshold: 0n })).toBeUndefined();
    });

    it("ages a median in whole minutes, never negative", () => {
        expect(medianAgeMinutes({ price: 1n, decimals: 8, updatedAt: 1000 }, 1600)).toBe(10);
        expect(medianAgeMinutes({ price: 1n, decimals: 8, updatedAt: 1000 }, 1000)).toBe(0);
        expect(medianAgeMinutes({ price: 1n, decimals: 8, updatedAt: 2000 }, 1000)).toBe(0);
    });
});
