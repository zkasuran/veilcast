import {
    CairoCustomEnum,
    Contract,
    num,
    type Abi,
    type Call,
    type ProviderInterface,
} from "starknet";
import { VEILCAST_MARKET_ABI } from "./abi.js";
import { decodeCategory, encodeCategory } from "./constants.js";

/// Lifecycle of a market, mirroring `MarketState` in the Cairo interface.
export type MarketState = "Open" | "Resolved" | "Void";

/// One market as the board shows it, decoded from `get_market_views`. Every field here is public
/// on-chain; none of it identifies a bettor, because the contract is never told one.
export type MarketView = {
    id: number;
    question: string;
    labels: string[];
    /// Staked on each outcome, in label order. This is the public price signal.
    volumes: bigint[];
    /// Total staked across every outcome, gross of any fee.
    pot: bigint;
    closeAt: number;
    createdAt: number;
    /// The opener's word for the section, decoded from a short string. Empty means uncategorised.
    category: string;
    /// The opener's cut of the pot at settlement, in basis points, fixed when the market opened.
    feeBps: number;
    feeRecipient: string;
    /// What the fee comes to once resolved and before it is collected.
    feeOwed: bigint;
    state: MarketState;
    winningOutcome: number;
    /// The only address that can resolve or void this market, as a padded hex string.
    resolver: string;
};

export type PositionStatus = "live" | "closed" | "won" | "lost" | "refundable" | "collected" | "empty";

/// A market contract bound to a provider for reads, or to an account for writes.
export function marketContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: VEILCAST_MARKET_ABI as Abi, address, providerOrAccount: provider });
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

/// One market by id, or undefined if it does not exist.
export async function loadMarket(
    provider: ProviderInterface,
    address: string,
    marketId: number
): Promise<MarketView | undefined> {
    const raw = (await marketContract(address, provider).call("get_market_views", [marketId, 1])) as unknown[];
    return raw.length > 0 ? decodeMarketView(raw[0]) : undefined;
}

/// The stake a coupon still holds on-chain. Zero means it was already collected.
export async function loadStake(
    provider: ProviderInterface,
    address: string,
    marketId: number,
    outcome: number,
    positionKey: string
): Promise<bigint> {
    return BigInt(
        (await marketContract(address, provider).call("get_stake", [marketId, outcome, positionKey])) as
            | bigint
            | number
    );
}

/// Opens a market. Anyone may open one; `resolver` is the only address that can settle it.
export function createMarketCall(
    address: string,
    question: string,
    labels: string[],
    resolver: string,
    closeAt: number,
    category = "",
    feeBps = 0,
    feeRecipient = "0x0"
): Call {
    return marketContract(address).populate("create_market", [
        question,
        labels,
        resolver,
        closeAt,
        encodeCategory(category),
        feeBps,
        feeBps > 0 ? feeRecipient : "0x0",
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

/// Pays a resolved market's fee to the address it was opened with. Anyone may send it.
export function collectFeeCall(address: string, marketId: number): Call {
    return marketContract(address).populate("collect_fee", [marketId]);
}

/// What a settled position collects, mirroring `payout_share`: the pot less the fee, split across
/// the winning side in proportion to stake, truncating like integer division. A void market refunds
/// the stake and charges nothing; a losing position is worth nothing.
export function settledPayout(view: MarketView, outcome: number, stake: bigint): bigint {
    if (view.state === "Void") return stake;
    if (view.state !== "Resolved" || outcome !== view.winningOutcome) return 0n;
    return share(stake, view.pot - view.feeOwed, view.volumes[outcome] ?? 0n);
}

/// What a stake would collect if its outcome won, mirroring `quote_payout`: the settled share for a
/// resolved market, or, while open, this stake's share of a pot that counts it, net of the fee.
export function quotePayout(view: MarketView, outcome: number, stake: bigint): bigint {
    if (view.state !== "Open") return settledPayout(view, outcome, stake);
    const gross = view.pot + stake;
    return share(stake, gross - feeOn(gross, view.feeBps), (view.volumes[outcome] ?? 0n) + stake);
}

/// `pot * feeBps / 10000`, truncating, exactly as the contract computes it.
export function feeOn(pot: bigint, feeBps: number): bigint {
    if (feeBps <= 0) return 0n;
    return (pot * BigInt(feeBps)) / 10_000n;
}

/// An outcome's share of the pot, 0 to 1, which is the market's implied probability for it. An empty
/// book has no opinion, so every outcome reads as an even split.
export function impliedProbability(outcomeVolume: bigint, pot: bigint, nOutcomes: number): number {
    if (pot === 0n) return nOutcomes > 0 ? 1 / nOutcomes : 0;
    return Number((outcomeVolume * 10_000n) / pot) / 10_000;
}

/// What a fresh stake on an outcome would return if it won, as a multiple of the stake, net of the
/// fee. The stake counts itself into both the pot and the winning side.
export function payoutMultiple(outcomeVolume: bigint, pot: bigint, stake: bigint, feeBps = 0): number {
    if (stake <= 0n) return 0;
    const winningVolume = outcomeVolume + stake;
    if (winningVolume === 0n) return 0;
    const gross = pot + stake;
    const net = gross - feeOn(gross, feeBps);
    return Number(((stake * net) / winningVolume * 10_000n) / stake) / 10_000;
}

/// Where a position stands, which is what gates its claim button. "empty" means the chain holds no
/// stake for a coupon that was never collected.
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
/// `ByteArray`, and a `CairoCustomEnum` for the state.
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
            fee_bps: bigint;
            fee_recipient: bigint;
            fee_owed: bigint;
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
        feeBps: Number(view.market.fee_bps),
        feeRecipient: num.toHex64(view.market.fee_recipient),
        feeOwed: BigInt(view.market.fee_owed),
        state: decodeMarketState(view.market.state),
        winningOutcome: Number(view.market.winning_outcome),
        resolver: num.toHex64(view.market.resolver),
    };
}

/// Reads the active variant of a Cairo unit enum. The parsed shape has changed between starknet.js
/// releases, so every form it has taken is accepted, and an unknown one reads as open, which offers
/// no claim rather than inventing a settlement.
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
    return variant ? Object.entries(variant).find(([, value]) => value !== undefined)?.[0] : undefined;
}

function share(stake: bigint, pot: bigint, winningVolume: bigint): bigint {
    if (winningVolume <= 0n) return 0n;
    return (stake * pot) / winningVolume;
}
