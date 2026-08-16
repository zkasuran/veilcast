"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { createMarketCall } from "@/utils/market";
import { MAX_OUTCOMES } from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

/// Opens a market. Public and permissionless, and the opener becomes its resolver.
export default function CreateMarket({ onCreated }: { onCreated: () => void }) {
    const strk20 = useStrk20();
    const [open, setOpen] = useState(false);
    const [question, setQuestion] = useState("");
    const [labelText, setLabelText] = useState("Yes, No");
    const [hours, setHours] = useState("24");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const labels = labelText.split(",").map((label) => label.trim()).filter(Boolean);
    const hoursOpen = Number(hours);
    const ready =
        question.trim().length > 0 &&
        labels.length >= 2 &&
        labels.length <= MAX_OUTCOMES &&
        Number.isFinite(hoursOpen) &&
        hoursOpen > 0 &&
        strk20.isConnected &&
        strk20.hasMarket;

    async function create() {
        if (!ready) return;
        setResult(null);
        setBusy(true);
        try {
            const closeAt = Math.floor(Date.now() / 1000) + Math.round(hoursOpen * 3600);
            const call = createMarketCall(
                strk20.marketAddress,
                question.trim(),
                labels,
                strk20.address,
                closeAt
            );
            const txHash = await strk20.execute([call], setResult, question.trim());
            if (txHash) {
                setQuestion("");
                onCreated();
            }
        } finally {
            setBusy(false);
        }
    }

    if (!open) {
        return (
            <button className={styles.newMarketToggle} onClick={() => setOpen(true)}>
                + Open a market
            </button>
        );
    }

    return (
        <div className={styles.createBox}>
            <div className={styles.createHead}>
                <span>Open a market</span>
                <button className={styles.modalClose} onClick={() => setOpen(false)} aria-label="Close">
                    ×
                </button>
            </div>
            <input
                className={styles.textInput}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Will STRK close above 1 USD on August 31?"
                aria-label="Question"
            />
            <input
                className={styles.textInput}
                value={labelText}
                onChange={(event) => setLabelText(event.target.value)}
                placeholder="Yes, No"
                aria-label="Outcomes, comma separated"
            />
            <input
                className={styles.textInput}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                inputMode="decimal"
                placeholder="Hours open"
                aria-label="Hours the market stays open"
            />
            <div className={styles.createNote}>
                {labels.length} outcomes, betting closes in {hours || "0"}h. You are the resolver: you
                settle it once it closes, or void it and every stake is refundable.
            </div>
            <button className={styles.btnCta} disabled={!ready || busy} onClick={create}>
                {busy ? "Submitting…" : "Open market"}
            </button>
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
