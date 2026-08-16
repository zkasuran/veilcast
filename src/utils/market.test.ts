import { CairoCustomEnum } from "starknet";
import { describe, expect, it } from "vitest";
import {
    type MarketView,
    createMarketCall,
    decodeMarketState,
    positionStatus,
    resolveCall,
    settledPayout,
    voidCall,
} from "./market";

const MARKET = "0x4d41524b4554";
const ONE_STRK = 10n ** 18n;

/// A resolved two-outcome market with 4 STRK on the winner and 2 on the loser, which is the book
/// the Cairo test `test_resolve_then_claim_pays_parimutuel_share_into_open_notes` settles.
function marketView(overrides: Partial<MarketView> = {}): MarketView {
    return {
        id: 0,
        question: "Will STRK close above 1 USD?",
        labels: ["Yes", "No"],
        volumes: [4n * ONE_STRK, 2n * ONE_STRK],
        pot: 6n * ONE_STRK,
        closeAt: 1000,
        state: "Resolved",
        winningOutcome: 0,
        resolver: "0x123",
        ...overrides,
    };
}

describe("settledPayout", () => {
    it("splits the whole pot across the winning side, in proportion to stake", () => {
        // 3 of the 4 STRK on the winner, so 3/4 of the 6 STRK pot.
        expect(settledPayout(marketView(), 0, 3n * ONE_STRK)).toBe(4_500_000_000_000_000_000n);
        expect(settledPayout(marketView(), 0, ONE_STRK)).toBe(1_500_000_000_000_000_000n);
    });

    it("pays a losing position nothing", () => {
        expect(settledPayout(marketView(), 1, 2n * ONE_STRK)).toBe(0n);
    });

    it("refunds the stake itself when the market is void", () => {
        expect(settledPayout(marketView({ state: "Void" }), 1, 2n * ONE_STRK)).toBe(2n * ONE_STRK);
    });

    it("offers nothing while the market is still open", () => {
        expect(settledPayout(marketView({ state: "Open" }), 0, 3n * ONE_STRK)).toBe(0n);
    });

    it("truncates like the contract's integer division rather than rounding", () => {
        // 1 wei of a 3 wei winning side, splitting a 10 wei pot: 3, not 3.33.
        const dust = marketView({ volumes: [3n, 7n], pot: 10n });
        expect(settledPayout(dust, 0, 1n)).toBe(3n);
    });
});

describe("decodeMarketState", () => {
    it("reads the active variant of a parsed Cairo enum", () => {
        const resolved = new CairoCustomEnum({ Open: undefined, Resolved: {}, Void: undefined });
        expect(decodeMarketState(resolved)).toBe("Resolved");
        const open = new CairoCustomEnum({ Open: {}, Resolved: undefined, Void: undefined });
        expect(decodeMarketState(open)).toBe("Open");
    });

    it("accepts the other shapes the variant has arrived in", () => {
        expect(decodeMarketState("Void")).toBe("Void");
        expect(decodeMarketState(2n)).toBe("Void");
        expect(decodeMarketState({ variant: { Open: undefined, Resolved: undefined, Void: {} } })).toBe("Void");
    });

    it("reads an unrecognisable state as open, which offers no claim", () => {
        expect(decodeMarketState(undefined)).toBe("Open");
        expect(decodeMarketState({})).toBe("Open");
        expect(decodeMarketState("Nonsense")).toBe("Open");
    });
});

describe("positionStatus", () => {
    const view = marketView();

    it("follows the market once the position is settled", () => {
        expect(positionStatus(view, 0, ONE_STRK, false)).toBe("won");
        expect(positionStatus(view, 1, ONE_STRK, false)).toBe("lost");
        expect(positionStatus(marketView({ state: "Void" }), 1, ONE_STRK, false)).toBe("refundable");
    });

    it("separates a live market from one waiting on its resolver", () => {
        const open = marketView({ state: "Open", closeAt: 1000 });
        expect(positionStatus(open, 0, ONE_STRK, false, 900)).toBe("live");
        expect(positionStatus(open, 0, ONE_STRK, false, 1000)).toBe("closed");
    });

    it("tells a collected position from one the chain never saw", () => {
        expect(positionStatus(view, 0, 0n, true)).toBe("collected");
        expect(positionStatus(view, 0, 0n, false)).toBe("empty");
    });
});

describe("market calls", () => {
    it("encodes create_market with the question and one label per outcome", () => {
        expect(createMarketCall(MARKET, "Will STRK close above 1 USD?", ["Yes", "No"], "0x123", 1000)).toEqual({
            contractAddress: MARKET,
            entrypoint: "create_market",
            calldata: [
                // question: no full 31-byte words, then the pending word and its length
                "0", "9205538097822543379981534287168375851077269384910981464042195076159", "28",
                // two labels, each a ByteArray of one short pending word
                "2", "0", "5858675", "3", "0", "20079", "2",
                "291", "1000",
            ],
        });
    });

    it("encodes the resolver's two calls", () => {
        expect(resolveCall(MARKET, 7, 1)).toEqual({
            contractAddress: MARKET,
            entrypoint: "resolve",
            calldata: ["7", "1"],
        });
        expect(voidCall(MARKET, 7)).toEqual({
            contractAddress: MARKET,
            entrypoint: "void",
            calldata: ["7"],
        });
    });
});
