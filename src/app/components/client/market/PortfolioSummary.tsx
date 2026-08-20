"use client";

import styles from "../../../uni.module.css";
import { type PositionPnl, closingSoon, portfolioTotals, positionsCsv, signedStrk } from "@/utils/portfolio";
import { formatStrk, formatTimeLeft } from "@/utils/veilcast";

/// The holder's book at a glance: what is staked, what it is worth, the net, and the two things that
/// want acting on, a position closing soon and a payout waiting to be collected.
///
/// Open positions are valued at the current odds, which is a live quote and not a promise, so the
/// value tile says so. Nothing here is on-chain state about the holder: it is the browser's own
/// coupons priced against the public board.
export default function PortfolioSummary({
    rows,
    onDownloadHref,
}: {
    rows: PositionPnl[];
    onDownloadHref: (csv: string) => void;
}) {
    if (rows.length === 0) return null;
    const totals = portfolioTotals(rows);
    const soon = closingSoon(rows);
    const pnlTone = totals.pnl > 0n ? styles.statUp : totals.pnl < 0n ? styles.statDown : "";

    return (
        <div className={styles.portfolio}>
            <div className={styles.statRow}>
                <Stat label="Staked" value={`${formatStrk(totals.staked)} STRK`} />
                <Stat label="Value now" value={`${formatStrk(totals.value)} STRK`} hint="open at current odds" />
                <Stat label="Net" value={`${signedStrk(totals.pnl)} STRK`} tone={pnlTone} />
                <Stat label="At risk" value={`${formatStrk(totals.atRisk)} STRK`} hint="on markets not settled" />
            </div>

            {totals.claimableCount > 0 ? (
                <div className={`${styles.alert} ${styles.alertGood}`}>
                    {totals.claimableCount} position{totals.claimableCount > 1 ? "s" : ""} ready to
                    collect, {formatStrk(totals.claimable)} STRK in all.
                </div>
            ) : null}

            {soon.length > 0 ? (
                <div className={styles.alert}>
                    Closing soon:{" "}
                    {soon.slice(0, 3).map((row, index) => (
                        <span key={row.coupon.positionKey}>
                            {index > 0 ? ", " : ""}
                            {row.label} on “{row.view?.question ?? `#${row.coupon.marketId}`}” in{" "}
                            {formatTimeLeft(row.view!.closeAt)}
                        </span>
                    ))}
                    {soon.length > 3 ? `, and ${soon.length - 3} more` : ""}.
                </div>
            ) : null}

            <button className={styles.btn} onClick={() => onDownloadHref(positionsCsv(rows))}>
                Download CSV
            </button>
        </div>
    );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
    return (
        <div className={styles.stat}>
            <span className={styles.statLabel}>{label}</span>
            <span className={`${styles.statValue} ${tone ?? ""}`}>{value}</span>
            {hint ? <span className={styles.statHint}>{hint}</span> : null}
        </div>
    );
}
