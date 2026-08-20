"use client";

import { type MarketView, type PositionStatus, positionStatus, quotePayout, settledPayout } from "./market";
import { type Coupon, formatStrk } from "./veilcast";

/// One coupon turned into a line a holder can read: what went in, what it is worth now, and the
/// difference. Value is exact once a market settles; while it is open, value is what the position
/// would pay at the current odds, which is a live quote rather than a promise.
export type PositionPnl = {
    coupon: Coupon;
    view: MarketView | undefined;
    status: PositionStatus;
    label: string;
    /// What the holder staked, from the coupon.
    staked: bigint;
    /// What the chain still holds for this coupon, zero once collected.
    stake: bigint;
    /// What the staked amount is worth: settled payout, refund, or the live quote while open.
    value: bigint;
    /// value - staked. Negative on a losing or losing-looking position.
    pnl: bigint;
    /// Whether `value` is settled fact or a live quote off the current odds.
    valueIsLive: boolean;
    claimed: boolean;
};

/// Everything a holder's coupons come to, split the way a holder thinks about it: what is settled and
/// realized, what is still riding on open markets, and what is sitting won or refundable waiting to
/// be collected.
export type PortfolioTotals = {
    positions: number;
    staked: bigint;
    value: bigint;
    pnl: bigint;
    /// Staked on markets that have not settled yet.
    atRisk: bigint;
    /// What the claimable positions would pay if collected now.
    claimable: bigint;
    claimableCount: number;
};

/// Builds one P&L line per coupon.
export function positionPnl(coupon: Coupon, view: MarketView | undefined, stake: bigint, now = seconds()): PositionPnl {
    const staked = BigInt(coupon.amount);
    const status = positionStatus(view, coupon.outcome, stake, Boolean(coupon.claimedTx), now);
    const label = view?.labels[coupon.outcome] ?? `outcome ${coupon.outcome}`;

    // Value is measured against the staked amount, not the remaining stake, so a collected position
    // still shows what it was worth rather than dropping to zero the moment it is claimed.
    let value = 0n;
    let valueIsLive = false;
    if (view) {
        if (view.state === "Void") {
            value = staked;
        } else if (view.state === "Resolved") {
            value = settledPayout({ ...view }, coupon.outcome, staked);
        } else {
            value = quotePayout(view, coupon.outcome, staked);
            valueIsLive = true;
        }
    } else {
        value = staked;
    }

    return {
        coupon,
        view,
        status,
        label,
        staked,
        stake,
        value,
        pnl: value - staked,
        valueIsLive,
        claimed: Boolean(coupon.claimedTx),
    };
}

/// Rolls a set of P&L lines into the totals the summary shows.
export function portfolioTotals(rows: PositionPnl[]): PortfolioTotals {
    const totals: PortfolioTotals = {
        positions: rows.length,
        staked: 0n,
        value: 0n,
        pnl: 0n,
        atRisk: 0n,
        claimable: 0n,
        claimableCount: 0,
    };
    for (const row of rows) {
        totals.staked += row.staked;
        totals.value += row.value;
        totals.pnl += row.pnl;
        if (row.view && row.view.state !== "Resolved" && row.view.state !== "Void") {
            totals.atRisk += row.staked;
        }
        if (isClaimable(row)) {
            totals.claimable += row.value;
            totals.claimableCount += 1;
        }
    }
    return totals;
}

/// A position the chain will pay right now: a won or refundable one that still holds a stake.
export function isClaimable(row: PositionPnl): boolean {
    return (row.status === "won" || row.status === "refundable") && row.stake > 0n && row.value > 0n;
}

/// Open positions on markets closing within `window` seconds, soonest first. What a holder wants
/// nudging about, because a closed market cannot be topped up or exited.
export function closingSoon(rows: PositionPnl[], window = 24 * 3600, now = seconds()): PositionPnl[] {
    return rows
        .filter((row) => row.view && row.view.state === "Open" && row.stake > 0n)
        .filter((row) => row.view!.closeAt > now && row.view!.closeAt - now <= window)
        .sort((left, right) => left.view!.closeAt - right.view!.closeAt);
}

/// The positions as a CSV a holder can keep or hand to an accountant. Amounts are STRK strings, not
/// wei, so the file reads without a converter. No key material: a coupon's public key identifies the
/// position, its private key never leaves the browser.
export function positionsCsv(rows: PositionPnl[]): string {
    const header = [
        "market_id",
        "question",
        "outcome",
        "status",
        "staked_strk",
        "value_strk",
        "pnl_strk",
        "value_basis",
        "position_key",
        "bet_tx",
        "claim_tx",
    ];
    const lines = rows.map((row) =>
        [
            row.coupon.marketId,
            csvCell(row.view?.question ?? ""),
            csvCell(row.label),
            row.status,
            formatStrk(row.staked),
            formatStrk(row.value),
            signedStrk(row.pnl),
            row.valueIsLive ? "current odds" : "settled",
            row.coupon.positionKey,
            row.coupon.betTx ?? "",
            row.coupon.claimedTx ?? "",
        ].join(",")
    );
    return [header.join(","), ...lines].join("\n");
}

/// A STRK amount with an explicit sign, for a P&L column where "+0.5" and "-0.5" must be told apart.
export function signedStrk(amount: bigint): string {
    return amount < 0n ? `-${formatStrk(-amount)}` : `+${formatStrk(amount)}`;
}

/// Wraps a cell in quotes when it carries a comma or a quote, so a question with a comma cannot
/// split a row. Doubles any embedded quote, which is what a CSV reader expects.
function csvCell(value: string): string {
    if (!/[",\n]/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
}

function seconds(): number {
    return Math.floor(Date.now() / 1000);
}
