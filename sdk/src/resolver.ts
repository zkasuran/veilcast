import { Contract, num, shortString, type Abi, type Call, type ProviderInterface } from "starknet";
import { PRAGMA_RESOLVER_ABI } from "./abi.js";
import { encodeCategory } from "./constants.js";

/// The Pragma feed resolver: a market bound to a spot pair and a threshold that anyone can settle
/// from the feed once it closes. No admin, no owner, no path that settles against what the feed says.

/// Outcome indices the resolver fixes, so a bettor never has to check which way a market was wired.
export const OUTCOME_AT_OR_ABOVE = 0;
export const OUTCOME_BELOW = 1;

/// The spot pairs Pragma reports at 8 decimals, checked against the live mainnet feed on 2026-08-16.
export const PAIRS = [
    { ticker: "STRK/USD", decimals: 8 },
    { ticker: "BTC/USD", decimals: 8 },
    { ticker: "ETH/USD", decimals: 8 },
] as const;

export type PriceQuestion = { ticker: string; threshold: bigint };
export type Median = { price: bigint; decimals: number; updatedAt: number };

export function resolverContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: PRAGMA_RESOLVER_ABI as Abi, address, providerOrAccount: provider });
}

/// Opens a market bound to a feed, with this resolver holding the resolver role. The opener is the
/// fee recipient, because the resolver contract cannot hold a balance to pay one out.
export function openPriceMarketCall(
    address: string,
    question: string,
    labelAtOrAbove: string,
    labelBelow: string,
    closeAt: number,
    category: string,
    ticker: string,
    threshold: bigint,
    feeBps = 0
): Call {
    return resolverContract(address).populate("open_price_market", [
        question,
        labelAtOrAbove,
        labelBelow,
        closeAt,
        encodeCategory(category),
        shortString.encodeShortString(ticker),
        threshold,
        feeBps,
    ]);
}

/// Pushes the feed's median into a bound market. Anyone may send it once the market has closed.
export function settleCall(address: string, marketId: number): Call {
    return resolverContract(address).populate("settle", [marketId]);
}

/// The question a market is bound to, or undefined if this resolver never opened it.
export async function loadPriceQuestion(
    provider: ProviderInterface,
    address: string,
    marketId: number
): Promise<PriceQuestion | undefined> {
    const raw = (await resolverContract(address, provider).call("get_price_question", [marketId])) as {
        pair_id: bigint;
        threshold: bigint;
    };
    const pairId = BigInt(raw.pair_id);
    if (pairId === 0n) return undefined;
    return { ticker: shortString.decodeShortString(num.toHex(pairId)), threshold: BigInt(raw.threshold) };
}

/// What the feed reports for a pair right now, which is what would settle a market on it this second.
export async function loadMedian(
    provider: ProviderInterface,
    address: string,
    ticker: string
): Promise<Median> {
    const raw = (await resolverContract(address, provider).call("read_median", [
        shortString.encodeShortString(ticker),
    ])) as unknown[];
    const [price, decimals, updatedAt] = raw.map((value) => BigInt(value as bigint));
    return { price, decimals: Number(decimals), updatedAt: Number(updatedAt) };
}

/// Formats a feed price at its own decimals, trimmed the way a price is written.
export function formatPrice(price: bigint, decimals: number): string {
    const unit = 10n ** BigInt(decimals);
    const whole = price / unit;
    const fraction = (price % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/// Parses a threshold into the feed's own units, or null for a non-positive or over-precise input.
export function parseThreshold(input: string, decimals: number): bigint | null {
    const trimmed = input.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
    const [whole, fraction = ""] = trimmed.split(".");
    if (fraction.length > decimals) return null;
    const unit = 10n ** BigInt(decimals);
    const scaled = BigInt(whole === "" ? "0" : whole) * unit + BigInt(fraction.padEnd(decimals, "0") || "0");
    return scaled > 0n ? scaled : null;
}
