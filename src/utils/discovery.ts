"use client";

import { num, shortString } from "starknet";
import type { MarketView } from "./market";

/// The sections the app offers when a market is opened. A category is the opener's own word, stored
/// as a short string, so this list is a convenience rather than a rule the contract enforces.
export const CATEGORIES = ["Crypto", "Sports", "Politics", "Culture", "Tech", "Other"] as const;

export type Category = (typeof CATEGORIES)[number];

/// What a market is doing right now, which is what the status filter is about.
export type MarketStatus = "live" | "closing" | "closed" | "resolved" | "void";

/// Markets closing inside this window read as closing soon, which is the only time pressure a
/// bettor actually cares about.
export const CLOSING_SOON = 6 * 3600;

export type SortKey = "closing" | "volume" | "newest";

export const SORTS: { key: SortKey; label: string }[] = [
    { key: "closing", label: "Closing soon" },
    { key: "volume", label: "Most volume" },
    { key: "newest", label: "Newest" },
];

/// A category as a felt, for calldata. An empty or unknown value means uncategorised, which the
/// contract accepts as zero.
export function encodeCategory(category: string): string {
    const trimmed = category.trim();
    if (trimmed === "") return "0x0";
    return shortString.encodeShortString(trimmed);
}

/// Reads a category back out of a felt. Anything that is not a short string reads as uncategorised
/// rather than throwing, because a market opened by another client is still a market.
export function decodeCategory(raw: bigint | string | number): string {
    try {
        const value = BigInt(raw as bigint);
        if (value === 0n) return "";
        return shortString.decodeShortString(num.toHex(value));
    } catch {
        return "";
    }
}

/// What a board shows for a market with no category.
export function categoryLabel(category: string): string {
    return category === "" ? "Uncategorised" : category;
}

export function marketStatus(view: MarketView, now = Math.floor(Date.now() / 1000)): MarketStatus {
    if (view.state === "Resolved") return "resolved";
    if (view.state === "Void") return "void";
    if (now >= view.closeAt) return "closed";
    return view.closeAt - now <= CLOSING_SOON ? "closing" : "live";
}

/// Whether a market is still taking bets. The contract enforces this too, so this is only about
/// what the board offers.
export function isBettable(view: MarketView, now = Math.floor(Date.now() / 1000)): boolean {
    const status = marketStatus(view, now);
    return status === "live" || status === "closing";
}

/// Case-insensitive match over everything a visitor can see: the question, the outcome labels, the
/// category and the market's own id, so "3" finds market 3.
export function matchesQuery(view: MarketView, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === "") return true;
    if (`#${view.id}` === needle || String(view.id) === needle) return true;
    const haystack = [view.question, view.category, ...view.labels].join(" ").toLowerCase();
    return haystack.includes(needle);
}

export type BoardFilter = {
    query: string;
    category: string;
    /// "all", or one status from `MarketStatus`. Kept as a string so the UI can pass its own value.
    status: string;
    sort: SortKey;
};

export const DEFAULT_FILTER: BoardFilter = {
    query: "",
    category: "all",
    status: "open",
    sort: "closing",
};

/// The board a visitor sees: filtered, then sorted. Pure, so the tests cover the whole behaviour.
export function applyFilter(
    markets: MarketView[],
    filter: BoardFilter,
    now = Math.floor(Date.now() / 1000)
): MarketView[] {
    const kept = markets.filter((view) => {
        if (!matchesQuery(view, filter.query)) return false;
        if (filter.category !== "all" && view.category !== filter.category) return false;
        const status = marketStatus(view, now);
        if (filter.status === "all") return true;
        // "open" is the useful default: anything still taking bets, whatever the clock says.
        if (filter.status === "open") return status === "live" || status === "closing";
        if (filter.status === "settled") return status === "resolved" || status === "void";
        return status === filter.status;
    });
    return sortMarkets(kept, filter.sort, now);
}

/// Sorts a copy, so a caller can hold the board's own order.
export function sortMarkets(
    markets: MarketView[],
    sort: SortKey,
    now = Math.floor(Date.now() / 1000)
): MarketView[] {
    const sorted = [...markets];
    if (sort === "volume") {
        sorted.sort((left, right) => compare(right.pot, left.pot) || right.id - left.id);
        return sorted;
    }
    if (sort === "newest") {
        sorted.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
        return sorted;
    }
    // Closing soon, with anything already closed pushed behind everything still open.
    sorted.sort((left, right) => {
        const leftOpen = left.closeAt > now;
        const rightOpen = right.closeAt > now;
        if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
        return leftOpen ? left.closeAt - right.closeAt : right.closeAt - left.closeAt;
    });
    return sorted;
}

/// The categories actually present on a board, in the order `CATEGORIES` lists them, with anything
/// unknown after. A board only offers a section that has something in it.
export function categoriesOnBoard(markets: MarketView[]): string[] {
    const present = new Set(markets.map((view) => view.category));
    const known = CATEGORIES.filter((category) => present.has(category)) as string[];
    const unknown = [...present].filter(
        (category) => category !== "" && !known.includes(category)
    );
    return [...known, ...unknown.sort()];
}

function compare(left: bigint, right: bigint): number {
    return left === right ? 0 : left > right ? 1 : -1;
}
