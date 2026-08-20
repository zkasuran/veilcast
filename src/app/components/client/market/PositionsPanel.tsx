"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { addrSTRK } from "@/utils/constants";
import { isClaimable, positionPnl } from "@/utils/portfolio";
import type { Coupon } from "@/utils/veilcast";
import { batchClaimIntoNotesActions, formatStrk, markCouponClaimed } from "@/utils/veilcast";
import PortfolioSummary from "./PortfolioSummary";
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
    const rows = ordered.map((coupon) =>
        positionPnl(coupon, markets.find((market) => market.id === coupon.marketId), positions.stakeOf(coupon))
    );

    // The coupons the chain will pay right now, and what they come to together.
    const claimable = rows.filter(isClaimable);
    const claimableCoupons = claimable.map((row) => row.coupon);
    const claimableTotal = claimable.reduce((sum, row) => sum + row.value, 0n);

    function downloadCsv(csv: string) {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `veilcast-positions-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    }

    /// Collects every claimable coupon in one pool transaction, each into its own private note.
    async function collectAll() {
        if (claimableCoupons.length === 0 || !strk20.hasMarket) return;
        setResult(null);
        setBusy(true);
        try {
            const actions = batchClaimIntoNotesActions(
                addrSTRK,
                strk20.marketAddress,
                claimableCoupons,
                strk20.address
            );
            const txHash = await strk20.submit(actions, setResult, `${formatStrk(claimableTotal)} STRK`);
            if (txHash) {
                for (const coupon of claimableCoupons) markCouponClaimed(coupon.positionKey, txHash);
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

            <PortfolioSummary rows={rows} onDownloadHref={downloadCsv} />
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
