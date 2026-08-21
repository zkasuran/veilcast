import { CallData, ec, num, shortString } from "starknet";
import { describe, expect, it } from "vitest";
import {
    type MarketView,
    VEILCAST_MARKET_ABI,
    batchClaimIntoNotesActions,
    betActions,
    collectFeeCall,
    createMarketCall,
    decodeMarketView,
    feeOn,
    openCommitteeMarketCall,
    openPriceMarketCall,
    quotePayout,
    settledPayout,
    voteCall,
} from "./index.js";

const MARKET = "0x4d41524b4554";
const TOKEN = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;

function view(overrides: Partial<MarketView> = {}): MarketView {
    return {
        id: 0,
        question: "Will STRK win?",
        labels: ["Yes", "No"],
        volumes: [3n * ONE, ONE],
        pot: 4n * ONE,
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

describe("decodeMarketView", () => {
    it("decodes a real get_market_views response through the shipped ABI", () => {
        const response = [
            "0x1", // one view
            "0x0", // market_id
            "0x123", // resolver
            "0x3e8", // close_at
            "0x1f4", // created_at
            shortString.encodeShortString("Crypto"),
            "0x2", // n_outcomes
            "0x1", // state = Resolved
            "0x0", // winning_outcome
            num.toHex(6n * ONE), // pot
            "0xc8", // fee_bps = 200
            "0x456", // fee_recipient
            num.toHex(120n * ONE / 1000n), // fee_owed
            "0x0", shortString.encodeShortString("Will STRK win?"), "0xe",
            "0x2", "0x0", shortString.encodeShortString("Yes"), "0x3", "0x0", shortString.encodeShortString("No"), "0x2",
            "0x2", num.toHex(4n * ONE), num.toHex(2n * ONE),
        ];
        const parsed = new CallData(VEILCAST_MARKET_ABI).parse("get_market_views", response) as unknown[];
        expect(decodeMarketView(parsed[0])).toEqual({
            id: 0,
            question: "Will STRK win?",
            labels: ["Yes", "No"],
            volumes: [4n * ONE, 2n * ONE],
            pot: 6n * ONE,
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
});

describe("payout math", () => {
    it("splits the pot less the fee across the winning side", () => {
        expect(feeOn(4n * ONE, 200)).toBe(80_000_000_000_000_000n);
        const resolved = view({ feeBps: 200, feeOwed: 80_000_000_000_000_000n });
        expect(settledPayout(resolved, 0, 3n * ONE)).toBe(3_920_000_000_000_000_000n);
        expect(settledPayout(resolved, 1, ONE)).toBe(0n);
        expect(settledPayout(view({ state: "Void" }), 1, 2n * ONE)).toBe(2n * ONE);
    });

    it("quotes an open market net of the fee it will charge", () => {
        const open = view({ state: "Open", volumes: [0n, 0n], pot: 0n, feeBps: 500, feeOwed: 0n });
        expect(quotePayout(open, 0, ONE)).toBe(950_000_000_000_000_000n);
    });
});

describe("calls and actions", () => {
    it("encodes create_market with category, fee and recipient", () => {
        const calldata = createMarketCall(MARKET, "Q", ["Yes", "No"], "0x123", 1000, "Crypto", 200, "0x456")
            .calldata as string[];
        // Last three felts are the category, the fee bps and the recipient.
        expect(calldata.slice(-3)).toEqual(["74158942745711", "200", "1110"]);
        expect(collectFeeCall(MARKET, 7).calldata).toEqual(["7"]);
    });

    it("orders a batch as every open note then every claim", () => {
        const coupon = {
            marketId: 1,
            outcome: 0,
            privateKey: "0x1234",
            positionKey: ec.starkCurve.getStarkKey("0x1234"),
            amount: ONE.toString(),
            createdAt: 0,
        };
        const actions = batchClaimIntoNotesActions(TOKEN, MARKET, [coupon, { ...coupon, outcome: 1 }], "0xme");
        expect(actions.map((action) => action.type)).toEqual(["transfer", "transfer", "invoke", "invoke"]);
        expect(betActions(TOKEN, MARKET, coupon).map((action) => action.type)).toEqual(["withdraw", "invoke"]);
    });

    it("encodes the resolver calls", () => {
        expect(voteCall("0xc0", 7, 255).calldata).toEqual(["7", "255"]);
        const price = openPriceMarketCall("0xr", "Q", "Yes", "No", 1000, "Crypto", "STRK/USD", 100_000_000n, 0)
            .calldata as string[];
        expect(price.at(-2)).toBe("100000000");
        const committee = openCommitteeMarketCall("0xc", "Q", ["Yes", "No"], 1000, "Sports", 0, ["0x1", "0x2"], 2)
            .calldata as string[];
        expect(committee.at(-1)).toBe("2");
    });
});
