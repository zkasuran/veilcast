"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { addrSTRK } from "@/utils/constants";
import type { Coupon } from "@/utils/veilcast";
import { batchClaimIntoNotesActions, formatStrk, markCouponClaimed } from "@/utils/veilcast";
import { settledPayout } from "@/utils/market";
import PositionRow from "./PositionRow";
import VaultTools from "./VaultTools";
import ResultCard from "../strk20/ResultCard";
import { useBoard } from "./useBoard";
import { usePositions } from "./usePositions";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

/// Everything this browser holds a coupon for.
///
/// The list is local. Nothing on-chain ties a position to an account, so there is no address to look
/// positions up by: the coupon in localStorage is the claim. That is the whole point. It is also the
/// risk, which is why the vault is one click from here.
export default function PositionsPanel() {
    const strk20 = useStrk20();
    const { markets, refresh: refreshBoard } = useBoard();
    const positions = usePositions();
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    function reload() {
        positions.reload();
        void refreshBoard();
    }

    const ordered = [...positions.coupons].sort((left, right) => right.createdAt - left.createdAt);

    /// The coupons the chain will pay right now: a won position on a resolved market, or any position
    /// on a void one, still holding a stake. These are what "collect all" sweeps.
    const claimable = ordered.filter((coupon) => {
        const view = markets.find((market) => market.id === coupon.marketId);
        if (!view || positions.stakeOf(coupon) === 0n) return false;
        return settledPayout(view, coupon.outcome, positions.stakeOf(coupon)) > 0n;
    });
    const claimableTotal = claimable.reduce((sum, coupon) => {
        const view = markets.find((market) => market.id === coupon.marketId);
        return sum + (view ? settledPayout(view, coupon.outcome, positions.stakeOf(coupon)) : 0n);
    }, 0n);

    /// Collects every claimable coupon in one pool transaction, each into its own private note.
    async function collectAll() {
        if (claimable.length === 0 || !strk20.hasMarket) return;
        setResult(null);
        setBusy(true);
        try {
            const actions = batchClaimIntoNotesActions(
                addrSTRK,
                strk20.marketAddress,
                claimable,
                strk20.address
            );
            const txHash = await strk20.submit(actions, setResult, `${formatStrk(claimableTotal)} STRK`);
            if (txHash) {
                for (const coupon of claimable) markCouponClaimed(coupon.positionKey, txHash);
                reload();
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.panelWide}>
            <div className={styles.boardHead}>
                <span className={styles.boardCount}>
                    {positions.coupons.length === 0
                        ? "No positions in this browser"
                        : `${positions.coupons.length} positions${claimable.length > 0 ? `, ${claimable.length} to collect` : ""}`}
                </span>
                <button className={styles.btn} onClick={reload}>
                    Refresh
                </button>
                {claimable.length > 1 ? (
                    <button
                        className={`${styles.btn} ${styles.btnGreen}`}
                        disabled={busy || !strk20.isConnected}
                        onClick={collectAll}
                    >
                        {busy ? "Collecting…" : `Collect all ${claimable.length} (${formatStrk(claimableTotal)} STRK)`}
                    </button>
                ) : null}
            </div>

            <VaultTools count={positions.coupons.length} onChanged={reload} />

            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
            {positions.error ? <div className={styles.warn}>{positions.error}</div> : null}

            {positions.coupons.length === 0 ? (
                <div className={styles.notice}>
                    A bet writes its coupon here. The coupon is a keypair generated in this browser and
                    stored nowhere else, so back it up: whoever holds it collects the payout, and nobody
                    who does not can.
                </div>
            ) : null}

            {ordered.map((coupon: Coupon) => (
                <PositionRow
                    key={coupon.positionKey}
                    coupon={coupon}
                    view={markets.find((market) => market.id === coupon.marketId)}
                    stake={positions.stakeOf(coupon)}
                    href={`/market/?id=${coupon.marketId}`}
                    onClaimed={reload}
                />
            ))}
        </div>
    );
}
