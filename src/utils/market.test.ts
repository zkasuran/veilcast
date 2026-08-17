import { CairoCustomEnum, CallData, num, shortString } from "starknet";
import { describe, expect, it } from "vitest";
import marketAbi from "@/abi/veilcastMarket.json";
import {
    type MarketView,
    collectFeeCall,
    createMarketCall,
    decodeMarketState,
    decodeMarketView,
    feeOn,
    positionStatus,
    quotePayout,
    resolveCall,
    settledPayout,
    voidCall,
} from "./market";
import { payoutMultiple } from "./veilcast";

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
        createdAt: 500,
        category: "Crypto",
        feeBps: 0,
        feeRecipient: "0x0",
        feeOwed: 0n,
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

describe("decodeMarketView", () => {
    /// The board is decoded from felts, so this drives the real ABI parser with the exact response
    /// `get_market_views` puts on the wire: one view, a two-outcome resolved market. If the struct's
    /// field order, the ByteArray layout or the enum encoding ever moves, this fails here rather than
    /// showing a visitor an empty board.
    const response = [
        "0x1", // one view in the returned array
        "0x0", // market_id
        "0x123", // market.resolver
        "0x3e8", // market.close_at
        "0x1f4", // market.created_at
        shortString.encodeShortString("Crypto"), // market.category
        "0x2", // market.n_outcomes
        "0x1", // market.state, variant index 1 = Resolved
        "0x0", // market.winning_outcome
        num.toHex(6n * ONE_STRK), // market.pot
        "0xc8", // market.fee_bps, 2%
        "0x456", // market.fee_recipient
        num.toHex(120n * ONE_STRK / 1000n), // market.fee_owed, 2% of the pot
        // question, as a ByteArray: no full 31-byte words, one pending word, its length
        "0x0", shortString.encodeShortString("Will STRK win?"), "0xe",
        "0x2", // two labels, each its own ByteArray
        "0x0", shortString.encodeShortString("Yes"), "0x3",
        "0x0", shortString.encodeShortString("No"), "0x2",
        "0x2", // two volumes
        num.toHex(4n * ONE_STRK), num.toHex(2n * ONE_STRK),
    ];

    it("reads a board response felt for felt", () => {
        const parsed = new CallData(marketAbi).parse("get_market_views", response) as unknown[];

        expect(parsed).toHaveLength(1);
        expect(decodeMarketView(parsed[0])).toEqual({
            id: 0,
            question: "Will STRK win?",
            labels: ["Yes", "No"],
            volumes: [4n * ONE_STRK, 2n * ONE_STRK],
            pot: 6n * ONE_STRK,
            closeAt: 1000,
            createdAt: 500,
            category: "Crypto",
            feeBps: 200,
            feeRecipient: "0x0000000000000000000000000000000000000000000000000000000000000456",
            feeOwed: 120_000_000_000_000_000n,
            state: "Resolved",
            winningOutcome: 0,
            resolver: "0x0000000000000000000000000000000000000000000000000000000000000123",
        });
    });

    it("pairs each label with the volume that belongs to it", () => {
        const parsed = new CallData(marketAbi).parse("get_market_views", response) as unknown[];
        const view = decodeMarketView(parsed[0]);

        expect(view.labels[view.winningOutcome]).toBe("Yes");
        // The whole winning side collects the pot less the 2% this market charges.
        expect(settledPayout(view, 0, 4n * ONE_STRK)).toBe(5_880_000_000_000_000_000n);
    });
});

describe("the market's fee", () => {
    /// The same numbers `test_fee_is_charged_once_at_settlement` asserts in Cairo: a 4 STRK pot at
    /// 2%, so 0.08 to the opener and 3.92 for the only winning coupon.
    const settled = marketView({
        volumes: [3n * ONE_STRK, ONE_STRK],
        pot: 4n * ONE_STRK,
        feeBps: 200,
        feeOwed: 80_000_000_000_000_000n,
    });

    it("comes off the pot before the winning side splits it", () => {
        expect(feeOn(4n * ONE_STRK, 200)).toBe(80_000_000_000_000_000n);
        expect(settledPayout(settled, 0, 3n * ONE_STRK)).toBe(3_920_000_000_000_000_000n);
    });

    it("is in the quote a bettor sees before betting", () => {
        // An empty book at 5%: one STRK in, 0.95 out.
        const empty = marketView({ volumes: [0n, 0n], pot: 0n, feeBps: 500, feeOwed: 0n, state: "Open" });
        expect(quotePayout(empty, 0, ONE_STRK)).toBe(950_000_000_000_000_000n);
        expect(payoutMultiple(0n, 0n, ONE_STRK, 500)).toBeCloseTo(0.95);

        // 3 on Yes, 1 on No, one more STRK on Yes: 5 STRK less 5% over 4 STRK of Yes.
        const open = marketView({
            volumes: [3n * ONE_STRK, ONE_STRK],
            pot: 4n * ONE_STRK,
            feeBps: 500,
            feeOwed: 0n,
            state: "Open",
        });
        expect(quotePayout(open, 0, ONE_STRK)).toBe(1_187_500_000_000_000_000n);
        expect(payoutMultiple(3n * ONE_STRK, 4n * ONE_STRK, ONE_STRK, 500)).toBeCloseTo(1.1875);
    });

    it("charges nothing on a void market, whatever the market advertised", () => {
        const voided = marketView({ state: "Void", feeBps: 500, feeOwed: 0n });
        expect(settledPayout(voided, 0, 3n * ONE_STRK)).toBe(3n * ONE_STRK);
        expect(quotePayout(voided, 0, 3n * ONE_STRK)).toBe(3n * ONE_STRK);
    });

    it("truncates the fee, so the dust stays with the bettors", () => {
        // 1% of 999 wei is 9.99, and the market keeps 9.
        expect(feeOn(999n, 100)).toBe(9n);
        expect(feeOn(999n, 0)).toBe(0n);
    });
});

describe("market calls", () => {
    it("encodes create_market with the question and one label per outcome", () => {
        expect(
            createMarketCall(
                MARKET,
                "Will STRK close above 1 USD?",
                ["Yes", "No"],
                "0x123",
                1000,
                "Crypto",
                200,
                "0x456"
            )
        ).toEqual({
            contractAddress: MARKET,
            entrypoint: "create_market",
            calldata: [
                // question: no full 31-byte words, then the pending word and its length
                "0", "9205538097822543379981534287168375851077269384910981464042195076159", "28",
                // two labels, each a ByteArray of one short pending word
                "2", "0", "5858675", "3", "0", "20079", "2",
                "291", "1000",
                // 'Crypto' as a short string, then 200 bps to its recipient
                "74158942745711", "200", "1110",
            ],
        });
    });

    it("sends a zero category when the opener did not pick one", () => {
        const calldata = createMarketCall(MARKET, "Q", ["Yes", "No"], "0x123", 1000, "")
            .calldata as string[];
        expect(calldata[calldata.length - 3]).toBe("0");
    });

    it("drops the fee recipient when there is no fee to pay it", () => {
        const calldata = createMarketCall(MARKET, "Q", ["Yes", "No"], "0x123", 1000, "Crypto", 0, "0x456")
            .calldata as string[];
        expect(calldata.slice(-2)).toEqual(["0", "0"]);
    });

    it("encodes the fee payout call, which carries nothing but the market id", () => {
        expect(collectFeeCall(MARKET, 7)).toEqual({
            contractAddress: MARKET,
            entrypoint: "collect_fee",
            calldata: ["7"],
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
