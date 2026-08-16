"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../../../uni.module.css";
import type { MarketView } from "@/utils/market";
import {
    type Median,
    OUTCOME_AT_OR_ABOVE,
    type PriceQuestion,
    formatPrice,
    loadMedian,
    loadPriceQuestion,
    medianAgeMinutes,
    settleCall,
} from "@/utils/resolver";
import { formatTimeLeft } from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, errorMessage, useStrk20 } from "../strk20/useStrk20";

/// The settlement panel for a market bound to a Pragma feed.
///
/// There is no resolver to trust here and no button only one person can press. The market was bound
/// to a pair and a threshold when it was opened, the feed's median decides the outcome and anyone can
/// be the one who pays the fee to push it in. Everything the settlement will use is on screen before
/// it happens.
export default function FeedSettle({ view, onSettled }: { view: MarketView; onSettled: () => void }) {
    const strk20 = useStrk20();
    const [question, setQuestion] = useState<PriceQuestion>();
    const [median, setMedian] = useState<Median>();
    const [note, setNote] = useState("");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const { provider, resolverAddress } = strk20;
    const load = useCallback(async () => {
        try {
            const bound = await loadPriceQuestion(provider, resolverAddress, view.id);
            setQuestion(bound);
            setMedian(bound ? await loadMedian(provider, resolverAddress, bound.ticker) : undefined);
            setNote("");
        } catch (failure) {
            setNote(`Could not read the feed: ${errorMessage(failure)}`);
        }
    }, [provider, resolverAddress, view.id]);

    useEffect(() => {
        void load();
    }, [load]);

    async function settle() {
        setResult(null);
        setBusy(true);
        try {
            const txHash = await strk20.execute(
                [settleCall(resolverAddress, view.id)],
                setResult,
                `settle #${view.id} from ${question?.ticker ?? "the feed"}`
            );
            if (txHash) {
                onSettled();
                void load();
            }
        } finally {
            setBusy(false);
        }
    }

    if (!question) {
        return note ? <div className={styles.resolverNote}>{note}</div> : null;
    }

    const now = Math.floor(Date.now() / 1000);
    const closed = now >= view.closeAt;
    const wouldWin =
        median && median.price >= question.threshold ? OUTCOME_AT_OR_ABOVE : OUTCOME_AT_OR_ABOVE + 1;

    return (
        <div className={styles.resolverBox}>
            <div className={styles.resolverHead}>Settled by a Pragma feed, by whoever asks</div>
            <div className={styles.feedRow}>
                <span className={styles.feedLabel}>Question</span>
                <span className={styles.feedValue}>
                    {question.ticker} at or above{" "}
                    {formatPrice(question.threshold, median?.decimals ?? 8)}
                </span>
            </div>
            <div className={styles.feedRow}>
                <span className={styles.feedLabel}>Feed says</span>
                <span className={styles.feedValue}>
                    {median === undefined || median.updatedAt === 0
                        ? "nothing yet"
                        : `${formatPrice(median.price, median.decimals)}, ${medianAgeMinutes(median, now)} min old`}
                </span>
            </div>
            <div className={styles.feedRow}>
                <span className={styles.feedLabel}>Would settle on</span>
                <span className={styles.feedValue}>{view.labels[wouldWin] ?? wouldWin}</span>
            </div>

            {closed ? (
                <button className={`${styles.btn} ${styles.btnGreen} ${styles.btnBlock}`} disabled={busy || !strk20.isConnected} onClick={settle}>
                    {busy ? "Settling…" : "Settle from the feed"}
                </button>
            ) : (
                <div className={styles.resolverNote}>
                    Settlement opens when the market closes, in {formatTimeLeft(view.closeAt, now)}.
                    Anyone can send it then, including you.
                </div>
            )}

            {note ? <div className={styles.resolverNote}>{note}</div> : null}
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
