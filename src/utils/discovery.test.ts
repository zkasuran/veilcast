import { describe, expect, it } from "vitest";
import {
    CATEGORIES,
    CLOSING_SOON,
    DEFAULT_FILTER,
    applyFilter,
    categoriesOnBoard,
    categoryLabel,
    decodeCategory,
    encodeCategory,
    isBettable,
    marketStatus,
    matchesQuery,
    sortMarkets,
} from "./discovery";
import type { MarketView } from "./market";

const ONE_STRK = 10n ** 18n;
const NOW = 1_000_000;

function marketView(overrides: Partial<MarketView> = {}): MarketView {
    return {
        id: 0,
        question: "Will STRK close above 1 USD?",
        labels: ["Yes", "No"],
        volumes: [ONE_STRK, ONE_STRK],
        pot: 2n * ONE_STRK,
        closeAt: NOW + 86_400,
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

describe("categories", () => {
    it("round-trips a category through a felt", () => {
        for (const category of CATEGORIES) {
            expect(decodeCategory(BigInt(encodeCategory(category)))).toBe(category);
        }
    });

    it("treats no category as uncategorised rather than as an error", () => {
        expect(encodeCategory("")).toBe("0x0");
        expect(encodeCategory("   ")).toBe("0x0");
        expect(decodeCategory(0n)).toBe("");
        expect(categoryLabel("")).toBe("Uncategorised");
        expect(categoryLabel("Sports")).toBe("Sports");
    });

    it("lists only the sections a board actually has, in a stable order", () => {
        const board = [
            marketView({ id: 1, category: "Tech" }),
            marketView({ id: 2, category: "Crypto" }),
            marketView({ id: 3, category: "Crypto" }),
            marketView({ id: 4, category: "" }),
            marketView({ id: 5, category: "Weather" }),
        ];
        // Known sections keep the order the app offers them in, anything else follows, sorted.
        expect(categoriesOnBoard(board)).toEqual(["Crypto", "Tech", "Weather"]);
        expect(categoriesOnBoard([])).toEqual([]);
    });
});

describe("marketStatus", () => {
    it("separates a market with time left from one about to close", () => {
        expect(marketStatus(marketView({ closeAt: NOW + 86_400 }), NOW)).toBe("live");
        expect(marketStatus(marketView({ closeAt: NOW + CLOSING_SOON }), NOW)).toBe("closing");
        expect(marketStatus(marketView({ closeAt: NOW + 60 }), NOW)).toBe("closing");
    });

    it("reads a closed market as waiting on its resolver, then as settled", () => {
        expect(marketStatus(marketView({ closeAt: NOW }), NOW)).toBe("closed");
        expect(marketStatus(marketView({ state: "Resolved" }), NOW)).toBe("resolved");
        expect(marketStatus(marketView({ state: "Void" }), NOW)).toBe("void");
    });

    it("offers a bet only while the market is taking them", () => {
        expect(isBettable(marketView(), NOW)).toBe(true);
        expect(isBettable(marketView({ closeAt: NOW + 60 }), NOW)).toBe(true);
        expect(isBettable(marketView({ closeAt: NOW }), NOW)).toBe(false);
        expect(isBettable(marketView({ state: "Resolved" }), NOW)).toBe(false);
    });
});

describe("matchesQuery", () => {
    const view = marketView({ id: 12, question: "Will STRK close above 1 USD?", labels: ["Yes", "No"] });

    it("searches everything a visitor can see", () => {
        expect(matchesQuery(view, "")).toBe(true);
        expect(matchesQuery(view, "strk")).toBe(true);
        expect(matchesQuery(view, "ABOVE 1 usd")).toBe(true);
        expect(matchesQuery(view, "crypto")).toBe(true);
        expect(matchesQuery(view, "yes")).toBe(true);
        expect(matchesQuery(view, "sports")).toBe(false);
    });

    it("finds a market by its id, with or without the hash", () => {
        expect(matchesQuery(view, "12")).toBe(true);
        expect(matchesQuery(view, "#12")).toBe(true);
        expect(matchesQuery(view, "13")).toBe(false);
    });
});

describe("sortMarkets", () => {
    const closingFirst = marketView({ id: 1, closeAt: NOW + 3600, pot: ONE_STRK, createdAt: 10 });
    const closingLater = marketView({ id: 2, closeAt: NOW + 86_400, pot: 9n * ONE_STRK, createdAt: 20 });
    const alreadyClosed = marketView({ id: 3, closeAt: NOW - 3600, pot: 5n * ONE_STRK, createdAt: 30 });
    const board = [alreadyClosed, closingLater, closingFirst];

    it("puts what is still open before what has closed, soonest first", () => {
        expect(sortMarkets(board, "closing", NOW).map((view) => view.id)).toEqual([1, 2, 3]);
    });

    it("sorts by volume, biggest pot first", () => {
        expect(sortMarkets(board, "volume", NOW).map((view) => view.id)).toEqual([2, 3, 1]);
    });

    it("sorts by when the market was opened", () => {
        expect(sortMarkets(board, "newest", NOW).map((view) => view.id)).toEqual([3, 2, 1]);
    });

    it("leaves the caller's array alone", () => {
        const original = [...board];
        sortMarkets(board, "volume", NOW);
        expect(board).toEqual(original);
    });
});

describe("applyFilter", () => {
    const live = marketView({ id: 1, closeAt: NOW + 86_400, category: "Crypto" });
    const closing = marketView({ id: 2, closeAt: NOW + 600, category: "Sports" });
    const closed = marketView({ id: 3, closeAt: NOW - 60, category: "Crypto" });
    const resolved = marketView({ id: 4, state: "Resolved", category: "Politics" });
    const voided = marketView({ id: 5, state: "Void", category: "Crypto" });
    const board = [live, closing, closed, resolved, voided];

    it("defaults to what a visitor can actually bet on", () => {
        expect(applyFilter(board, DEFAULT_FILTER, NOW).map((view) => view.id)).toEqual([2, 1]);
    });

    it("groups settled markets together, whichever way they settled", () => {
        const settled = applyFilter(board, { ...DEFAULT_FILTER, status: "settled" }, NOW);
        expect(settled.map((view) => view.id).sort()).toEqual([4, 5]);
    });

    it("filters one status at a time when asked for one", () => {
        for (const [status, ids] of [
            ["live", [1]],
            ["closing", [2]],
            ["closed", [3]],
            ["resolved", [4]],
            ["void", [5]],
        ] as const) {
            expect(applyFilter(board, { ...DEFAULT_FILTER, status }, NOW).map((view) => view.id)).toEqual(ids);
        }
    });

    it("narrows to one section and searches inside it", () => {
        // Order is the sort's business, so this only cares about what survived the filter.
        expect(
            applyFilter(board, { ...DEFAULT_FILTER, status: "all", category: "Crypto" }, NOW)
                .map((view) => view.id)
                .sort()
        ).toEqual([1, 3, 5]);
        expect(
            applyFilter(board, { ...DEFAULT_FILTER, status: "all", query: "#4" }, NOW).map(
                (view) => view.id
            )
        ).toEqual([4]);
        expect(applyFilter(board, { ...DEFAULT_FILTER, query: "nothing here" }, NOW)).toEqual([]);
    });

    it("shows everything when nothing is filtered", () => {
        expect(applyFilter(board, { ...DEFAULT_FILTER, status: "all", sort: "newest" }, NOW)).toHaveLength(5);
    });
});
