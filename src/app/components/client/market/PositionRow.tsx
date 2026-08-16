"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { addrSTRK } from "@/utils/constants";
import { type MarketView, type PositionStatus, positionStatus, settledPayout } from "@/utils/market";
import {
    type Coupon,
    claimIntoNoteActions,
    claimToWalletActions,
    formatStrk,
    markCouponClaimed,
} from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, shortHex, useStrk20 } from "../strk20/useStrk20";

const STATUS: Record<PositionStatus, { text: string; tone: string }> = {
    live: { text: "live", tone: "pillPink" },
    closed: { text: "awaiting resolution", tone: "pillGrey" },
    won: { text: "won", tone: "pillGreen" },
    lost: { text: "lost", tone: "pillGrey" },
    refundable: { text: "refundable", tone: "pillGreen" },
    collected: { text: "collected", tone: "pillGrey" },
    empty: { text: "no stake on chain", tone: "pillGrey" },
};

/// One coupon: what it backs, what the chain still owes it and the two ways to collect.
///
/// A win pays into a fresh open note by default, which keeps the payout inside the pool as a private
/// note-to-note transfer. Paying out to an address is offered too, and it is the honest trade: the
/// amount and the recipient become public the moment it leaves.
export default function PositionRow({
    coupon,
    view,
    stake,
    onClaimed,
}: {
    coupon: Coupon;
    view: MarketView | undefined;
    stake: bigint;
    onClaimed: () => void;
}) {
    const strk20 = useStrk20();
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const status = positionStatus(view, coupon.outcome, stake, Boolean(coupon.claimedTx));
    const pill = STATUS[status];
    const payout = view ? settledPayout(view, coupon.outcome, stake) : 0n;
    const claimable = (status === "won" || status === "refundable") && payout > 0n;
    const label = view?.labels[coupon.outcome] ?? `outcome ${coupon.outcome}`;

    async function claim(into: "note" | "wallet") {
        setResult(null);
        setBusy(true);
        try {
            const actions =
                into === "note"
                    ? claimIntoNoteActions(addrSTRK, strk20.marketAddress, coupon, strk20.address)
                    : claimToWalletActions(strk20.marketAddress, coupon, strk20.address);
            const txHash = await strk20.submit(actions, setResult, `${formatStrk(payout)} STRK`);
            if (txHash) {
                markCouponClaimed(coupon.positionKey, txHash);
                onClaimed();
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.positionRow}>
            <div className={styles.positionHead}>
                <span className={styles.positionQuestion}>
                    {view?.question ?? `Market #${coupon.marketId}`}
                </span>
                <span className={`${styles.pill} ${styles[pill.tone]}`}>{pill.text}</span>
            </div>
            <div className={styles.positionFacts}>
                <span>
                    <b>{formatStrk(BigInt(coupon.amount))} STRK</b> on {label}
                </span>
                {stake > 0n && stake !== BigInt(coupon.amount) ? (
                    <span>{formatStrk(stake)} STRK still open</span>
                ) : null}
                {claimable ? <span className={styles.positionPayout}>collects {formatStrk(payout)} STRK</span> : null}
                <span className={styles.subMono}>coupon {shortHex(coupon.positionKey)}</span>
            </div>

            {claimable ? (
                <div className={styles.positionActions}>
                    <button
                        className={`${styles.btn} ${styles.btnGreen}`}
                        disabled={busy || !strk20.isConnected}
                        onClick={() => claim("note")}
                    >
                        {busy ? "Collecting…" : "Collect privately"}
                    </button>
                    <button
                        className={styles.btn}
                        disabled={busy || !strk20.isConnected}
                        onClick={() => claim("wallet")}
                    >
                        Collect to my wallet (public)
                    </button>
                </div>
            ) : null}

            {status === "empty" ? (
                <div className={styles.positionNote}>
                    The chain holds no stake for this coupon. Either the bet never landed, or it was
                    already collected somewhere else holding the same backup.
                </div>
            ) : null}

            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
