import { hash, num, type ProviderInterface } from "starknet";

/// A market's history, read from its own events. Every event the market emits carries the market id
/// as its second key, so one filtered query returns everything that happened to one market. Nothing
/// here carries an address: a bet is an amount, an outcome and a coupon key, and so is a claim.

export type MarketEventKind = "created" | "bet" | "resolved" | "void" | "claimed";

const SELECTORS: Record<MarketEventKind, string> = {
    created: hash.getSelectorFromName("MarketCreated"),
    bet: hash.getSelectorFromName("BetPlaced"),
    resolved: hash.getSelectorFromName("MarketResolved"),
    void: hash.getSelectorFromName("MarketVoided"),
    claimed: hash.getSelectorFromName("PayoutClaimed"),
};

export type MarketEvent = {
    kind: MarketEventKind;
    marketId: number;
    blockNumber: number;
    txHash: string;
    outcome?: number;
    amount?: bigint;
    /// That outcome's running total after a bet, which is what makes the odds history exact.
    outcomeVolume?: bigint;
    positionKey?: string;
    category?: string;
};

export type RawEvent = {
    keys: string[];
    data: string[];
    block_number?: number;
    transaction_hash?: string;
};

/// Everything that happened to one market, oldest first. One filtered query, paged to the end.
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

/// Decodes raw events, dropping anything Veilcast does not emit. An unknown selector is another
/// contract's business, not an error.
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
            decoded.push({ ...base, positionKey: event.keys[2] ?? "", amount: num.toBigInt(event.data[0] ?? "0x0") });
        } else if (kind === "resolved") {
            decoded.push({ ...base, outcome: Number(num.toBigInt(event.data[0] ?? "0x0")), amount: num.toBigInt(event.data[1] ?? "0x0") });
        } else if (kind === "created") {
            decoded.push({ ...base, category: event.keys[2] ?? "0x0" });
        } else {
            decoded.push(base);
        }
    }
    return decoded;
}

/// One point of a market's history: where the odds stood after a bet landed.
export type OddsPoint = {
    index: number;
    blockNumber: number;
    txHash: string;
    outcome: number;
    volumes: bigint[];
    pot: bigint;
    probabilities: number[];
};

/// The odds as they actually stood, rebuilt from the bets. Every `BetPlaced` carries that outcome's
/// running total, so this is the market's real history, not a replay of the contract's arithmetic.
export function oddsSeries(events: MarketEvent[], nOutcomes: number): OddsPoint[] {
    const volumes = new Array<bigint>(nOutcomes).fill(0n);
    const points: OddsPoint[] = [];
    let index = 0;
    for (const event of events) {
        if (event.kind !== "bet" || event.outcome === undefined || event.outcome >= nOutcomes) continue;
        volumes[event.outcome] = event.outcomeVolume ?? volumes[event.outcome];
        const pot = volumes.reduce((sum, volume) => sum + volume, 0n);
        points.push({
            index: (index += 1),
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
