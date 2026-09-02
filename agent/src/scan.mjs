/// The two scans an autonomous agent runs on a loop.
///
/// Both are read-only and free: they enumerate positions from the event log, mark each one against the
/// live book and report what is actionable. Nothing here sends a transaction, so a watcher can run
/// continuously and only spend when it has something worth doing.

import { levBoard, levMandate, levPosition, openedPositions } from "./chain.mjs";
import { keeperReward, mandateStatus, markPosition } from "./pricing.mjs";

/// Every open position, marked, with the board it belongs to. The shared first half of both scans.
///
/// Positions are keyed by bearer coupon rather than by owner, so the contract has no way to list them
/// and the `PositionOpened` log is the index. A position that has since closed or been liquidated
/// reads back as not Open and is dropped here.
async function livePositions(config) {
    const board = await levBoard(config);
    const byId = new Map(board.map((market) => [market.id, market]));
    const opened = await openedPositions(config);
    const live = [];
    for (const record of opened) {
        const market = byId.get(record.marketId);
        if (!market || market.state !== "Open") continue;
        const position = await levPosition(config, record.marketId, record.side, record.positionKey);
        if (position.state !== "Open") continue;
        live.push({ ...record, market, position, mark: markPosition(market, record.side, position) });
    }
    return { board, live };
}

/// Find every position a keeper may liquidate right now and what each one pays.
///
/// A position is liquidatable at or below the 8% maintenance floor. The reward is 1% of notional capped
/// by the surplus the sale actually produces, so a deeply underwater position can pay less than the
/// headline rate. `minRewardWei` filters out liquidations that would not cover their own gas, which is
/// the difference between a keeper that earns and one that donates.
export async function scanKeeper(config, { minRewardWei = 0n } = {}) {
    const { board, live } = await livePositions(config);
    const candidates = [];
    for (const entry of live) {
        if (!entry.mark.liquidatable) continue;
        const reward = keeperReward(entry.position, entry.mark);
        if (reward < minRewardWei) continue;
        candidates.push({
            marketId: entry.marketId,
            side: entry.side,
            positionKey: entry.positionKey,
            healthBps: entry.mark.healthBps,
            value: entry.mark.value,
            equity: entry.mark.equity,
            borrowed: entry.position.borrowed,
            notional: entry.position.margin + entry.position.borrowed,
            reward,
            openedAtBlock: entry.blockNumber,
        });
    }
    // Best paying first, so a keeper with one transaction of budget spends it well.
    candidates.sort((left, right) => (right.reward > left.reward ? 1 : right.reward < left.reward ? -1 : 0));
    return {
        markets: board.length,
        positionsScanned: live.length,
        liquidatable: candidates.length,
        candidates,
    };
}

/// Find every mandate this agent holds and which of them are firable right now.
///
/// `agentKey` is the agent's public key. Positions mandated to anyone else are reported as `others` so
/// an operator can see the market's shape, but they carry no action: the contract would refuse the
/// close and attempting it wastes gas to be told BAD_CLOSE_SIGNATURE.
export async function scanMandates(config, agentKey) {
    const { board, live } = await livePositions(config);
    const mine = [];
    let others = 0;
    for (const entry of live) {
        const held = await levMandate(config, entry.marketId, entry.side, entry.positionKey);
        if (BigInt(held.agentKey) === 0n) continue;
        if (agentKey && BigInt(held.agentKey) !== BigInt(agentKey)) {
            others += 1;
            continue;
        }
        const status = mandateStatus(entry.market, entry.side, held);
        mine.push({
            marketId: entry.marketId,
            side: entry.side,
            positionKey: entry.positionKey,
            mandate: held,
            priceBps: status.priceBps,
            stopHit: status.stopHit,
            takeHit: status.takeHit,
            firable: status.firable,
            reason: status.reason,
            equity: entry.mark.equity,
            healthBps: entry.mark.healthBps,
            // A position at the floor will be liquidated by a keeper if the agent does not act and a
            // liquidation costs the owner the penalty, so a firable stop here is time-sensitive.
            alsoLiquidatable: entry.mark.liquidatable,
        });
    }
    return {
        markets: board.length,
        positionsScanned: live.length,
        mandatesHeld: mine.length,
        firable: mine.filter((entry) => entry.firable).length,
        mandatedToOthers: others,
        mandates: mine,
    };
}
