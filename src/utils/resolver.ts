"use client";

import { Contract, num, shortString, type Abi, type Call, type ProviderInterface } from "starknet";
import resolverAbi from "@/abi/pragmaResolver.json";
import { encodeCategory } from "./discovery";

const ABI = resolverAbi as Abi;

/// Outcome indices the resolver fixes, matching OUTCOME_AT_OR_ABOVE and OUTCOME_BELOW in
/// cairo/src/pragma_resolver.cairo. Fixed rather than per market, so a bettor never has to check
/// which way round a particular price market was wired.
export const OUTCOME_AT_OR_ABOVE = 0;
export const OUTCOME_BELOW = 1;

/// The spot pairs this app offers. Pragma reports all three at 8 decimals, checked against the live
/// mainnet feed on 2026-08-16. A pair is passed on-chain as its ticker encoded as a short string.
export const PAIRS = [
    { ticker: "STRK/USD", decimals: 8 },
    { ticker: "BTC/USD", decimals: 8 },
    { ticker: "ETH/USD", decimals: 8 },
] as const;

export type PriceQuestion = {
    /// The pair's ticker, decoded back from the felt the contract stores.
    ticker: string;
    /// The line the question is about, in the feed's own decimals.
    threshold: bigint;
};

/// What the feed says right now, which is what would settle the market if it closed this second.
export type Median = { price: bigint; decimals: number; updatedAt: number };

export function resolverContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: ABI, address, providerOrAccount: provider });
}

/// Opens a market bound to a feed, with this resolver holding the resolver role.
export function openPriceMarketCall(
    address: string,
    question: string,
    labelAtOrAbove: string,
    labelBelow: string,
    closeAt: number,
    category: string,
    ticker: string,
    threshold: bigint
): Call {
    return resolverContract(address).populate("open_price_market", [
        question,
        labelAtOrAbove,
        labelBelow,
        closeAt,
        encodeCategory(category),
        shortString.encodeShortString(ticker),
        threshold,
    ]);
}

/// Pushes the feed's median into a bound market. Anyone may send this once the market has closed:
/// the feed decides the outcome, the caller only pays the fee.
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
    return decodePriceQuestion(raw);
}

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

export function decodePriceQuestion(raw: {
    pair_id: bigint;
    threshold: bigint;
}): PriceQuestion | undefined {
    const pairId = BigInt(raw.pair_id);
    if (pairId === 0n) return undefined;
    return {
        ticker: shortString.decodeShortString(num.toHex(pairId)),
        threshold: BigInt(raw.threshold),
    };
}

/// Formats a feed price at its own decimals, trimmed the way a price is normally written.
export function formatPrice(price: bigint, decimals: number): string {
    const unit = 10n ** BigInt(decimals);
    const whole = price / unit;
    const fraction = (price % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/// Parses a threshold a user typed into the feed's own units. Returns null for anything that is not
/// a positive number, so a caller never has to trust the input.
export function parseThreshold(input: string, decimals: number): bigint | null {
    const trimmed = input.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
    const [whole, fraction = ""] = trimmed.split(".");
    if (fraction.length > decimals) return null;
    const unit = 10n ** BigInt(decimals);
    const scaled =
        BigInt(whole === "" ? "0" : whole) * unit + BigInt(fraction.padEnd(decimals, "0") || "0");
    return scaled > 0n ? scaled : null;
}

/// How stale the median is, in whole minutes, for a UI that has to say so.
export function medianAgeMinutes(median: Median, now = Math.floor(Date.now() / 1000)): number {
    return Math.max(0, Math.round((now - median.updatedAt) / 60));
}
