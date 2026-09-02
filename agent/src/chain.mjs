/// Read-only chain access. Everything here is free, needs no key and never sends a transaction, so
/// an agent can orient itself completely before it decides to spend anything.
///
/// Reads go over plain JSON-RPC rather than through a contract abstraction, so the runtime has no
/// build step and no ABI files to keep in sync. The decoding mirrors the Cairo structs directly.

import { hash, num } from "starknet";

/// One JSON-RPC call, with a clear error when the node refuses.
export async function rpc(rpcUrl, method, params) {
    const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) {
        const error = new Error(`RPC ${method} returned HTTP ${response.status}`);
        error.code = "RPC_HTTP";
        throw error;
    }
    const body = await response.json();
    if (body.error) {
        const error = new Error(`RPC ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
        error.code = "RPC_ERROR";
        error.data = body.error;
        throw error;
    }
    return body.result;
}

/// Call a view entrypoint and get back raw felts.
export async function callView(config, contract, selector, calldata = []) {
    return rpc(config.rpcUrl, "starknet_call", [
        { contract_address: contract, entry_point_selector: selector, calldata: calldata.map(toFelt) },
        "latest",
    ]);
}

/// Entrypoint selectors, precomputed at import so a read costs one round trip.
///
/// starknet.js computes these from the name; hardcoding them would be faster but would silently break
/// if an entrypoint were renamed, so the name stays the source of truth.
const selector = (name) => hash.getSelectorFromName(name);

export const SELECTORS = {
    getNMarkets: selector("get_n_markets"),
    getMarketViews: selector("get_market_views"),
    getStake: selector("get_stake"),
    getMarket: selector("get_market"),
    getPosition: selector("get_position"),
    getMandate: selector("get_mandate"),
    priceBps: selector("price_bps"),
    positionEquity: selector("position_equity"),
    getVaultFree: selector("get_vault_free"),
    getTotalBacking: selector("get_total_backing"),
    getInsurance: selector("get_insurance"),
    getVaultShares: selector("get_vault_shares"),
    balanceOf: selector("balanceOf"),
};

function toFelt(value) {
    if (typeof value === "bigint" || typeof value === "number") return num.toHex(value);
    return String(value);
}

/// The chain head and the block an agent should prove against.
///
/// The pool rejects a proof whose base block is newer than about 10 blocks old, so proving happens
/// at `head - proveLag`. This is the single most common cause of an otherwise correct pool action
/// being refused, so it lives in one function that every write path uses.
export async function proveBlock(config) {
    const head = await rpc(config.rpcUrl, "starknet_blockNumber", []);
    return { head, proveAt: head - config.proveLag };
}

/// An ERC20 balance in the smallest unit.
export async function tokenBalance(config, owner, token = config.token) {
    const [low, high] = await callView(config, token, SELECTORS.balanceOf, [owner]);
    return BigInt(low) + (BigInt(high ?? 0) << 128n);
}

/// How many leveraged markets exist. Zero is a valid answer, not an error.
export async function levMarketCount(config) {
    const [count] = await callView(config, config.leverage, SELECTORS.getNMarkets);
    return Number(BigInt(count));
}

/// One leveraged market, decoded from `get_market`. The field order follows the `LevMarket` struct in
/// cairo/src/leverage_interface.cairo exactly: resolver, close_at, created_at, r_yes, r_no, state,
/// winning_side, liquidity, borrowed_yes, borrowed_no.
export async function levMarket(config, marketId) {
    const raw = await callView(config, config.leverage, SELECTORS.getMarket, [marketId]);
    return {
        id: marketId,
        resolver: num.toHex64(BigInt(raw[0])),
        closeAt: Number(BigInt(raw[1])),
        createdAt: Number(BigInt(raw[2])),
        rYes: BigInt(raw[3]),
        rNo: BigInt(raw[4]),
        state: ["Open", "Resolved", "Void"][Number(BigInt(raw[5]))] ?? "Open",
        winningSide: Number(BigInt(raw[6])),
        liquidity: BigInt(raw[7]),
        borrowedYes: BigInt(raw[8]),
        borrowedNo: BigInt(raw[9]),
    };
}

/// Every leveraged market, newest first.
export async function levBoard(config) {
    const count = await levMarketCount(config);
    const markets = [];
    for (let id = count - 1; id >= 0; id -= 1) markets.push(await levMarket(config, id));
    return markets;
}

/// A leveraged position, decoded from `get_position`: shares, margin, borrowed, state.
export async function levPosition(config, marketId, side, positionKey) {
    const raw = await callView(config, config.leverage, SELECTORS.getPosition, [marketId, side, positionKey]);
    return {
        shares: BigInt(raw[0]),
        margin: BigInt(raw[1]),
        borrowed: BigInt(raw[2]),
        state: ["None", "Open", "Closed", "Liquidated"][Number(BigInt(raw[3]))] ?? "None",
    };
}

/// The mandate a position carries, decoded from `get_mandate`: agent_key, stop, take, payout_target.
///
/// A zeroed agent key means the position is self-managed, so no agent close can ever pass. Reading
/// this is how an agent learns what authority it actually has rather than trusting an instruction.
export async function levMandate(config, marketId, side, positionKey) {
    const raw = await callView(config, config.leverage, SELECTORS.getMandate, [marketId, side, positionKey]);
    return {
        agentKey: num.toHex(BigInt(raw[0])),
        stopPriceBps: Number(BigInt(raw[1])),
        takePriceBps: Number(BigInt(raw[2])),
        payoutTarget: num.toHex64(BigInt(raw[3])),
    };
}

/// The vault's free collateral, committed backing and insurance fund, plus the contract's actual
/// token balance. Together these are the solvency invariant: balance must cover the three.
export async function vaultState(config) {
    const [free, backing, insurance, balance] = await Promise.all([
        callView(config, config.leverage, SELECTORS.getVaultFree).then(([value]) => BigInt(value)),
        callView(config, config.leverage, SELECTORS.getTotalBacking).then(([value]) => BigInt(value)),
        callView(config, config.leverage, SELECTORS.getInsurance).then(([value]) => BigInt(value)),
        tokenBalance(config, config.leverage),
    ]);
    const obligations = free + backing + insurance;
    return { free, backing, insurance, balance, obligations, solvent: balance >= obligations };
}

/// Every `PositionOpened` event the leveraged market has emitted, which is how a keeper enumerates
/// positions without being told about them.
///
/// The contract has no "list positions" view, because positions are keyed by a bearer coupon rather
/// than an owner, so the event log is the index. Keys are [selector, market_id, side, position_key],
/// so a position's identity comes straight off the keys with no data decoding needed.
export async function openedPositions(config, { chunkSize = 200, maxChunks = 40 } = {}) {
    const wanted = hash.getSelectorFromName("PositionOpened");
    const found = [];
    let continuation;
    for (let page = 0; page < maxChunks; page += 1) {
        const result = await rpc(config.rpcUrl, "starknet_getEvents", [
            {
                address: config.leverage,
                from_block: { block_number: 0 },
                to_block: "latest",
                keys: [[wanted]],
                chunk_size: chunkSize,
                ...(continuation ? { continuation_token: continuation } : {}),
            },
        ]);
        for (const event of result.events ?? []) {
            found.push({
                marketId: Number(BigInt(event.keys[1] ?? "0x0")),
                side: Number(BigInt(event.keys[2] ?? "0x0")),
                positionKey: num.toHex(BigInt(event.keys[3] ?? "0x0")),
                blockNumber: event.block_number,
                txHash: event.transaction_hash,
            });
        }
        continuation = result.continuation_token;
        if (!continuation) break;
    }
    return found;
}

/// A transaction receipt, with the two facts that matter for verifying a pool action: did it succeed,
/// and did the pool actually emit an event in it.
///
/// The pool appearing in `events[].from_address` is the program's own eligibility test, so this is the
/// check a judge would run, not a proxy for it.
export async function receiptFacts(config, txHash, extraAddress) {
    const receipt = await rpc(config.rpcUrl, "starknet_getTransactionReceipt", [txHash]);
    const from = (receipt.events ?? []).map((event) => normalize(event.from_address));
    return {
        txHash,
        finality: receipt.finality_status,
        execution: receipt.execution_status,
        succeeded: receipt.execution_status === "SUCCEEDED",
        poolEvent: from.includes(normalize(config.pool)),
        ...(extraAddress ? { contractEvent: from.includes(normalize(extraAddress)) } : {}),
        events: from.length,
        actualFee: receipt.actual_fee?.amount ?? receipt.actual_fee,
    };
}

/// The class hash actually deployed at an address, for verifying a recorded deployment.
export async function classHashAt(config, address) {
    return rpc(config.rpcUrl, "starknet_getClassHashAt", ["latest", address]);
}

function normalize(address) {
    return String(address).replace(/^0x0*/, "").toLowerCase();
}
