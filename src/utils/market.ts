"use client";

import { CairoCustomEnum, Contract, num, type Abi, type Call, type ProviderInterface } from "starknet";
import marketAbi from "@/abi/veilcastMarket.json";
import { decodeCategory, encodeCategory } from "./discovery";

const ABI = marketAbi as Abi;

/// Lifecycle of a market, mirroring `MarketState` in cairo/src/interface.cairo.
export type MarketState = "Open" | "Resolved" | "Void";

/// One market as the board shows it, decoded from `get_market_views`.
///
/// `volumes` is the public price signal: how much is staked on each outcome, in the same order as
/// `labels`. Nothing here identifies a bettor, because the contract is never told one.
export type MarketView = {
    id: number;
    question: string;
    labels: string[];
    volumes: bigint[];
    /// Total staked across every outcome. The whole pot goes to the winning side.
    pot: bigint;
    /// Unix seconds. Bets are refused from this point, resolution is refused before it.
    closeAt: number;
    /// Unix seconds when the market was opened, which is what "newest" on the board sorts by.
    createdAt: number;
    /// The opener's own word for what the question is about, decoded from a short string. Empty
    /// means they did not say.
    category: string;
    state: MarketState;
    /// Meaningful only when `state` is "Resolved".
    winningOutcome: number;
    /// The only address allowed to resolve or void this market, as a padded hex string.
    resolver: string;
};

/// A market contract bound to a provider for reads. Writes go through `populate` plus the wallet,
/// so nothing here ever needs an account.
export function marketContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: ABI, address, providerOrAccount: provider });
}

/// The newest `limit` markets, newest first. Two calls whatever the board size: one for the count,
/// one for the window.
export async function loadBoard(
    provider: ProviderInterface,
    address: string,
    limit = 24
): Promise<MarketView[]> {
    const contract = marketContract(address, provider);
    const nMarkets = Number(await contract.call("get_n_markets", []));
    if (nMarkets === 0) return [];
    const start = Math.max(0, nMarkets - limit);
    const raw = (await contract.call("get_market_views", [start, nMarkets - start])) as unknown[];
    return raw.map(decodeMarketView).reverse();
}

/// The stake a coupon still holds, straight from the chain. Zero means it was already collected,
/// which is the only place a claim from another browser shows up.
export async function loadStake(
    provider: ProviderInterface,
    address: string,
    marketId: number,
    outcome: number,
    positionKey: string
): Promise<bigint> {
    const contract = marketContract(address, provider);
    return BigInt(
        (await contract.call("get_stake", [marketId, outcome, positionKey])) as bigint | number
    );
}

/// Opens a market. Anyone may open one; `resolver` is the only address that can settle it.
/// `category` is a plain word the board groups by, and "" means uncategorised.
export function createMarketCall(
    address: string,
    question: string,
    labels: string[],
    resolver: string,
    closeAt: number,
    category: string
): Call {
    return marketContract(address).populate("create_market", [
        question,
        labels,
        resolver,
        closeAt,
        encodeCategory(category),
    ]);
}

/// Settles a closed market on `winningOutcome`. Resolver only, enforced on-chain.
export function resolveCall(address: string, marketId: number, winningOutcome: number): Call {
    return marketContract(address).populate("resolve", [marketId, winningOutcome]);
}

/// Cancels a market so every stake is refundable. Resolver at any time, anyone once the grace
/// period past the close has elapsed.
export function voidCall(address: string, marketId: number): Call {
    return marketContract(address).populate("void", [marketId]);
}

/// What a settled position collects, mirroring `payout_share` in cairo/src/market.cairo: the whole
/// pot split across the winning side in proportion to stake, truncating like integer division does.
/// A void market refunds the stake itself, and a losing position is worth nothing.
export function settledPayout(view: MarketView, outcome: number, stake: bigint): bigint {
    if (view.state === "Void") return stake;
    if (view.state !== "Resolved" || outcome !== view.winningOutcome) return 0n;
    const winningVolume = view.volumes[outcome] ?? 0n;
    if (winningVolume === 0n) return 0n;
    return (stake * view.pot) / winningVolume;
}

/// Where a position stands, which is what the Positions tab shows and what gates its claim button.
/// "empty" means the chain holds no stake for this coupon: either the bet never landed, or it was
/// collected from another browser holding the same backup.
export type PositionStatus = "live" | "closed" | "won" | "lost" | "refundable" | "collected" | "empty";

export function positionStatus(
    view: MarketView | undefined,
    outcome: number,
    stake: bigint,
    claimed: boolean,
    now = Math.floor(Date.now() / 1000)
): PositionStatus {
    if (stake === 0n) return claimed ? "collected" : "empty";
    if (!view) return "live";
    if (view.state === "Void") return "refundable";
    if (view.state === "Resolved") return outcome === view.winningOutcome ? "won" : "lost";
    return now < view.closeAt ? "live" : "closed";
}

/// Decodes one entry of `get_market_views`. starknet.js hands back bigints, a decoded string per
/// `ByteArray` and a `CairoCustomEnum` for the state. Exported so a test can drive it with the exact
/// felts the contract puts on the wire.
export function decodeMarketView(raw: unknown): MarketView {
    const view = raw as {
        market_id: bigint;
        market: {
            resolver: bigint;
            close_at: bigint;
            created_at: bigint;
            category: bigint;
            n_outcomes: bigint;
            state: unknown;
            winning_outcome: bigint;
            pot: bigint;
        };
        question: string;
        outcome_labels: string[];
        outcome_volumes: bigint[];
    };
    return {
        id: Number(view.market_id),
        question: view.question,
        labels: view.outcome_labels.map(String),
        volumes: view.outcome_volumes.map((volume) => BigInt(volume)),
        pot: BigInt(view.market.pot),
        closeAt: Number(view.market.close_at),
        createdAt: Number(view.market.created_at),
        category: decodeCategory(view.market.category),
        state: decodeMarketState(view.market.state),
        winningOutcome: Number(view.market.winning_outcome),
        resolver: num.toHex64(view.market.resolver),
    };
}

/// Reads the active variant of a Cairo unit enum. The parsed shape has changed between starknet.js
/// releases, so every form it has taken is accepted and an unknown one reads as open, which offers
/// no claim and no refund rather than inventing a settlement.
export function decodeMarketState(state: unknown): MarketState {
    const name = variantName(state);
    return name === "Resolved" || name === "Void" ? name : "Open";
}

function variantName(state: unknown): string | undefined {
    if (typeof state === "string") return state;
    if (typeof state === "bigint" || typeof state === "number") {
        return ["Open", "Resolved", "Void"][Number(state)];
    }
    const custom = state as CairoCustomEnum | undefined;
    if (typeof custom?.activeVariant === "function") return custom.activeVariant();
    const variant = (state as { variant?: Record<string, unknown> } | undefined)?.variant;
    return variant
        ? Object.entries(variant).find(([, value]) => value !== undefined)?.[0]
        : undefined;
}
