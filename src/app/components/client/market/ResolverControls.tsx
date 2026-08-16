"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { type MarketView, resolveCall, voidCall } from "@/utils/market";
import { formatTimeLeft } from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

/// The controls only a market's resolver sees.
///
/// Resolution is a public call, on purpose: the terms of a market are not the thing that needs
/// hiding, and a settlement nobody can point at is not a settlement. What stays private is who was
/// on which side of it.
export default function ResolverControls({
    view,
    onSettled,
}: {
    view: MarketView;
    onSettled: () => void;
}) {
    const strk20 = useStrk20();
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);
    const now = Math.floor(Date.now() / 1000);
    const closed = now >= view.closeAt;

    async function send(kind: "resolve" | "void", outcome?: number) {
        setResult(null);
        setBusy(true);
        try {
            const call =
                kind === "resolve"
                    ? resolveCall(strk20.marketAddress, view.id, outcome ?? 0)
                    : voidCall(strk20.marketAddress, view.id);
            const label =
                kind === "resolve"
                    ? `resolve #${view.id} on ${view.labels[outcome ?? 0]}`
                    : `void #${view.id}`;
            const txHash = await strk20.execute([call], setResult, label);
            if (txHash) onSettled();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.resolverBox}>
            <div className={styles.resolverHead}>You resolve this market</div>
            {closed ? (
                <div className={styles.resolverRow}>
                    <span className={styles.resolverLabel}>Winning outcome</span>
                    {view.labels.map((label, outcome) => (
                        <button
                            key={outcome}
                            className={`${styles.btn} ${styles.btnGreen}`}
                            disabled={busy}
                            onClick={() => send("resolve", outcome)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            ) : (
                <div className={styles.resolverNote}>
                    Resolution opens when the market closes, in {formatTimeLeft(view.closeAt, now)}.
                </div>
            )}
            <div className={styles.resolverRow}>
                <span className={styles.resolverLabel}>Or cancel it</span>
                <button className={styles.btn} disabled={busy} onClick={() => send("void")}>
                    Void and refund every stake
                </button>
            </div>
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
