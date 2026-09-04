"use client";

import { hash, num, type ProviderInterface } from "starknet";

/// The market's five events, keyed by selector. Every one of them carries the market id as its
/// second key, so one filtered query returns a market's whole history.
const SELECTORS: Record<MarketEventKind, string> = {
    created: hash.getSelectorFromName("MarketCreated"),
    bet: hash.getSelectorFromName("BetPlaced"),
    resolved: hash.getSelectorFromName("MarketResolved"),
    void: hash.getSelectorFromName("MarketVoided"),
    claimed: hash.getSelectorFromName("PayoutClaimed"),
};

export type MarketEventKind = "created" | "bet" | "resolved" | "void" | "claimed";

/// One thing that happened to a market, as the chain published it.
///
/// There is no address on any of these, because the market is never told one. A bet carries an
/// amount, an outcome and a coupon's public key, and a claim carries the same key again. That pair
/// is the only link anyone can draw, and it points at a key rather than at a person.
export type MarketEvent = {
    kind: MarketEventKind;
    marketId: number;
    blockNumber: number;
    txHash: string;
    /// The outcome a bet backed, or the one a resolution settled on.
    outcome?: number;
    /// The stake for a bet, the payout for a claim, the pot for a resolution.
    amount?: bigint;
    /// That outcome's running total after a bet, which is what makes a history exact.
    outcomeVolume?: bigint;
    positionKey?: string;
    category?: string;
};

/// A raw event as the RPC returns it, narrowed to the fields this reads.
export type RawEvent = {
    keys: string[];
    data: string[];
    block_number?: number;
    transaction_hash?: string;
};

/// Everything that ever happened to one market, oldest first.
///
/// One filtered query, paged to the end, so a market's history costs the same whether the board has
/// three markets or three hundred. `maxChunks` is a guard rather than a feature: a market with more
/// events than that is one the app should be reading from an indexer instead.
export async function loadMarketEvents(
    provider: ProviderInterface,
    address: string,
    marketId: number,
    { chunkSize = 200, maxChunks = 25 }: { chunkSize?: number; maxChunks?: number } = {}
): Promise<MarketEvent[]> {
    const events: MarketEvent[] = [];
    let continuationToken: string | undefined;
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
        const page = await provider.getEvents({
            address,
            from_block: { block_number: 0 },
            to_block: "latest",
            // Any of the market's events, for this market id.
            keys: [[], [num.toHex(marketId)]],
            chunk_size: chunkSize,
            continuation_token: continuationToken,
        });
        events.push(...decodeEvents(page.events as RawEvent[]));
        continuationToken = page.continuation_token;
        if (!continuationToken) break;
    }
    return events;
}

/// Everything that happened on the whole board, newest first. Same wire format as a single market's
/// history but with no market-id filter, so a dashboard can show the chain's pulse across markets.
export async function loadBoardActivity(
    provider: ProviderInterface,
    address: string,
    { chunkSize = 200, maxChunks = 12 }: { chunkSize?: number; maxChunks?: number } = {}
): Promise<MarketEvent[]> {
    const events: MarketEvent[] = [];
    let continuationToken: string | undefined;
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
        const page = await provider.getEvents({
            address,
            from_block: { block_number: 0 },
            to_block: "latest",
            keys: [[], []],
            chunk_size: chunkSize,
            continuation_token: continuationToken,
        });
        events.push(...decodeEvents(page.events as RawEvent[]));
        continuationToken = page.continuation_token;
        if (!continuationToken) break;
    }
    return events.sort((left, right) => right.blockNumber - left.blockNumber);
}

/// Decodes raw events, dropping anything this app does not publish. An unknown selector is another
/// contract's business, or a newer version of this one, and neither is an error.
export function decodeEvents(raw: RawEvent[]): MarketEvent[] {
    const decoded: MarketEvent[] = [];
    for (const event of raw) {
        const kind = kindOf(event.keys?.[0]);
        if (!kind) continue;
        const base = {
            kind,
            marketId: Number(num.toBigInt(event.keys[1] ?? "0x0")),
            blockNumber: event.block_number ?? 0,
            txHash: event.transaction_hash ?? "",
        };
        if (kind === "bet") {
            decoded.push({
                ...base,
                outcome: Number(num.toBigInt(event.keys[2] ?? "0x0")),
                positionKey: event.keys[3] ?? "",
                amount: num.toBigInt(event.data[0] ?? "0x0"),
                outcomeVolume: num.toBigInt(event.data[1] ?? "0x0"),
            });
        } else if (kind === "claimed") {
            decoded.push({
                ...base,
                positionKey: event.keys[2] ?? "",
                amount: num.toBigInt(event.data[0] ?? "0x0"),
            });
        } else if (kind === "resolved") {
            decoded.push({
                ...base,
                outcome: Number(num.toBigInt(event.data[0] ?? "0x0")),
                amount: num.toBigInt(event.data[1] ?? "0x0"),
            });
        } else if (kind === "created") {
            decoded.push({ ...base, category: event.keys[2] ?? "0x0" });
        } else {
            decoded.push(base);
        }
    }
    return decoded;
}

function kindOf(selector: string | undefined): MarketEventKind | undefined {
    if (!selector) return undefined;
    let value: bigint;
    try {
        value = num.toBigInt(selector);
    } catch {
        return undefined;
    }
    for (const [kind, known] of Object.entries(SELECTORS)) {
        if (num.toBigInt(known) === value) return kind as MarketEventKind;
    }
    return undefined;
}

/// One point of a market's history: where the odds stood after a bet landed.
export type OddsPoint = {
    /// Position in the market's own sequence of bets, which is what the chart's x axis is.
    index: number;
    blockNumber: number;
    txHash: string;
    /// The outcome this bet backed, so the chart can mark which line moved.
    outcome: number;
    /// Staked on each outcome at this point, in outcome order.
    volumes: bigint[];
    pot: bigint;
    /// Each outcome's share of the pot, 0 to 1, in outcome order.
    probabilities: number[];
};

/// The odds as they actually stood, rebuilt from the bets.
///
/// Every `BetPlaced` carries that outcome's running total, so this is the market's real history
/// rather than a guess: no replay of the contract's arithmetic, no interpolation, nothing that can
/// drift from what the chain says.
export function oddsSeries(events: MarketEvent[], nOutcomes: number): OddsPoint[] {
    const volumes = new Array<bigint>(nOutcomes).fill(0n);
    const points: OddsPoint[] = [];
    let index = 0;
    for (const event of events) {
        if (event.kind !== "bet" || event.outcome === undefined) continue;
        if (event.outcome >= nOutcomes) continue;
        volumes[event.outcome] = event.outcomeVolume ?? volumes[event.outcome];
        const pot = volumes.reduce((sum, volume) => sum + volume, 0n);
        points.push({
            index: index += 1,
            blockNumber: event.blockNumber,
            txHash: event.txHash,
            outcome: event.outcome,
            volumes: [...volumes],
            pot,
            probabilities: volumes.map((volume) =>
                pot === 0n ? 1 / nOutcomes : Number((volume * 10_000n) / pot) / 10_000
            ),
        });
    }
    return points;
}
