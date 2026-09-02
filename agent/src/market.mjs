/// The parimutuel market: the board, the odds and the payout maths, ported from
/// cairo/src/market.cairo felt for felt.
///
/// This is the half of Veilcast that is already live on mainnet, so everything here works today with
/// no deployment step. An agent reading this module can price a bet, decide whether the odds are worth
/// taking and know exactly what a winning coupon collects, before it spends anything.
///
/// The pricing is parimutuel rather than an AMM: every stake goes into one pot and the winning side
/// splits it in proportion to stake, net of the market's fee. That means the odds an agent sees are a
/// function of public volume alone, which is precisely what the privacy model preserves.

import { callView, SELECTORS, rpc } from "./chain.mjs";

const BPS = 10_000n;

/// The market's fee on a pot, truncating exactly as the contract computes it.
export function feeOn(pot, feeBps) {
    if (feeBps <= 0) return 0n;
    return (pot * BigInt(feeBps)) / BPS;
}

/// An outcome's share of the pot, which is the market's implied probability for it. An empty book has
/// no opinion, so every outcome reads as an even split rather than a divide by zero.
export function impliedProbability(outcomeVolume, pot, nOutcomes) {
    if (pot === 0n) return nOutcomes > 0 ? 1 / nOutcomes : 0;
    return Number((outcomeVolume * BPS) / pot) / 10_000;
}

/// What a settled position collects, mirroring `payout_share`: the pot less the fee, split across the
/// winning side in proportion to stake. A void market refunds the stake and charges nothing; a losing
/// position is worth nothing.
export function settledPayout(view, outcome, stake) {
    if (view.state === "Void") return stake;
    if (view.state !== "Resolved" || outcome !== view.winningOutcome) return 0n;
    const winningVolume = view.volumes[outcome] ?? 0n;
    if (winningVolume <= 0n) return 0n;
    return (stake * (view.pot - view.feeOwed)) / winningVolume;
}

/// What a stake would collect if its outcome won, mirroring `quote_payout`. While the market is open
/// the stake counts itself into both the pot and the winning side, which is what makes the quote
/// honest: an agent sees the odds it will actually get, not the odds before its own money moved them.
export function quotePayout(view, outcome, stake) {
    if (view.state !== "Open") return settledPayout(view, outcome, stake);
    const gross = view.pot + stake;
    const winningVolume = (view.volumes[outcome] ?? 0n) + stake;
    if (winningVolume <= 0n) return 0n;
    return (stake * (gross - feeOn(gross, view.feeBps))) / winningVolume;
}

/// The payout as a multiple of the stake, which is the number a trader actually reasons about. Below
/// 1.0 a winning bet still loses money, so an agent should refuse it.
export function payoutMultiple(view, outcome, stake) {
    if (stake <= 0n) return 0;
    const payout = quotePayout(view, outcome, stake);
    return Number((payout * BPS) / stake) / 10_000;
}

/// Where a position stands, which is what decides whether an agent can collect.
export function positionStatus(view, outcome, stake, now = Math.floor(Date.now() / 1000)) {
    if (stake === 0n) return "empty";
    if (!view) return "live";
    if (view.state === "Void") return "refundable";
    if (view.state === "Resolved") return outcome === view.winningOutcome ? "won" : "lost";
    return now < view.closeAt ? "live" : "closed";
}
// PLACEHOLDER_MARKET

/// Decode `get_market_views` from raw felts.
///
/// The contract returns `Array<MarketView>` and a MarketView carries two Cairo types that do not have
/// a flat felt representation, so the layout has to be walked rather than indexed:
///
/// - a `ByteArray` serializes as `[n_full_words, ...words, pending_word, pending_len]`, where each full
///   word packs 31 bytes and the pending word holds the remainder. That is why the question and every
///   outcome label are variable width and the fields after them cannot sit at fixed offsets.
/// - an `Array<T>` serializes as `[len, ...items]`.
///
/// Doing this over plain JSON-RPC rather than through a contract abstraction keeps the runtime free of
/// a build step and of ABI files that can drift from the deployment.
export function decodeMarketViews(felts) {
    let index = 0;
    const next = () => felts[index++];
    const count = Number(BigInt(next()));
    const views = [];
    for (let view = 0; view < count; view += 1) {
        const marketId = Number(BigInt(next()));
        const resolver = next();
        const closeAt = Number(BigInt(next()));
        const createdAt = Number(BigInt(next()));
        const category = next();
        const nOutcomes = Number(BigInt(next()));
        const state = ["Open", "Resolved", "Void"][Number(BigInt(next()))] ?? "Open";
        const winningOutcome = Number(BigInt(next()));
        const pot = BigInt(next());
        const feeBps = Number(BigInt(next()));
        const feeRecipient = next();
        const feeOwed = BigInt(next());
        const question = readByteArray(next, felts);
        const labelCount = Number(BigInt(next()));
        const labels = [];
        for (let label = 0; label < labelCount; label += 1) labels.push(readByteArray(next, felts));
        const volumeCount = Number(BigInt(next()));
        const volumes = [];
        for (let volume = 0; volume < volumeCount; volume += 1) volumes.push(BigInt(next()));
        views.push({
            id: marketId,
            question,
            labels,
            volumes,
            pot,
            closeAt,
            createdAt,
            category: decodeShortString(category),
            nOutcomes,
            feeBps,
            feeRecipient,
            feeOwed,
            state,
            winningOutcome,
            resolver,
        });
    }
    return views;
}

/// Read one `ByteArray` off the felt stream: full 31-byte words, then a partial pending word.
function readByteArray(next) {
    const wordCount = Number(BigInt(next()));
    let text = "";
    for (let word = 0; word < wordCount; word += 1) text += decodeShortString(next());
    const pending = next();
    const pendingLength = Number(BigInt(next()));
    if (pendingLength > 0) text += decodeShortString(pending);
    return text;
}

/// Decode a felt holding packed ASCII. Bytes outside printable ASCII are dropped rather than rendered,
/// because a label is only ever text and a stray byte should not corrupt the whole board.
function decodeShortString(felt) {
    let value = BigInt(felt);
    const bytes = [];
    while (value > 0n) {
        bytes.unshift(Number(value & 0xffn));
        value >>= 8n;
    }
    return bytes
        .filter((byte) => byte >= 32 && byte < 127)
        .map((byte) => String.fromCharCode(byte))
        .join("");
}

/// The whole parimutuel board, newest first, with the odds already computed.
///
/// Two calls whatever the board size: one for the count, one for the window. Every number here is
/// public on-chain by design, which is what lets an agent price a bet without an account.
export async function board(config, { limit = 24 } = {}) {
    const [count] = await callView(config, config.market, SELECTORS.getNMarkets);
    const total = Number(BigInt(count));
    if (total === 0) return { count: 0, markets: [] };
    const start = Math.max(0, total - limit);
    const felts = await callView(config, config.market, SELECTORS.getMarketViews, [start, total - start]);
    const views = decodeMarketViews(felts).reverse();
    return {
        count: total,
        markets: views.map((view) => ({
            ...view,
            outcomes: view.labels.map((label, outcome) => ({
                outcome,
                label,
                volume: view.volumes[outcome] ?? 0n,
                impliedProbability: impliedProbability(view.volumes[outcome] ?? 0n, view.pot, view.nOutcomes),
            })),
        })),
    };
}

/// One market by id or undefined when it does not exist.
export async function market(config, marketId) {
    const felts = await callView(config, config.market, SELECTORS.getMarketViews, [marketId, 1]);
    const [view] = decodeMarketViews(felts);
    return view;
}

/// The stake a coupon still holds on-chain. Zero means it was already collected, which is the only
/// place a claim made from another device shows up.
export async function stakeOf(config, marketId, outcome, positionKey) {
    const [stake] = await callView(config, config.market, SELECTORS.getStake, [marketId, outcome, positionKey]);
    return BigInt(stake);
}

/// Every bet the market has seen, from its own event log, which is how an agent reads the flow without
/// being told about it. `BetPlaced` carries the running outcome volume, so the odds history is exact
/// rather than a replay of our own arithmetic.
///
/// `fromBlock` matters more than it looks. A public RPC will happily answer a 14-million-block scan with
/// an empty page rather than an error, so asking from genesis silently returns nothing and looks like a
/// market with no activity. Callers should pass the deployment block; `DEPLOYED_AT` is the default.
export async function betHistory(config, marketId, { fromBlock = DEPLOYED_AT, chunkSize = 200, maxChunks = 20 } = {}) {
    const { hash, num } = await import("starknet");
    const wanted = hash.getSelectorFromName("BetPlaced");
    const bets = [];
    let continuation;
    for (let page = 0; page < maxChunks; page += 1) {
        const result = await rpc(config.rpcUrl, "starknet_getEvents", [
            {
                address: config.market,
                from_block: { block_number: fromBlock },
                to_block: "latest",
                keys: [[wanted], [num.toHex(marketId)]],
                chunk_size: chunkSize,
                ...(continuation ? { continuation_token: continuation } : {}),
            },
        ]);
        for (const event of result.events ?? []) {
            bets.push({
                marketId: Number(BigInt(event.keys[1] ?? "0x0")),
                outcome: Number(BigInt(event.keys[2] ?? "0x0")),
                positionKey: num.toHex(BigInt(event.keys[3] ?? "0x0")),
                amount: BigInt(event.data[0] ?? "0x0"),
                outcomeVolume: BigInt(event.data[1] ?? "0x0"),
                blockNumber: event.block_number,
                txHash: event.transaction_hash,
            });
        }
        continuation = result.continuation_token;
        if (!continuation) break;
    }
    return bets;
}

/// The block VeilcastMarket was deployed in. Event scans start here rather than at genesis, because a
/// public RPC answers an over-wide range with an empty page instead of an error.
export const DEPLOYED_AT = 13_890_000;
