"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { CATEGORIES } from "@/utils/discovery";
import { createMarketCall } from "@/utils/market";
import { PAIRS, openPriceMarketCall, parseThreshold } from "@/utils/resolver";
import { MAX_OUTCOMES } from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

/// Opens a market. Public and permissionless, and the opener becomes its resolver.
///
/// Unless it is bound to a price feed, in which case the Pragma adapter is the resolver and nobody,
/// including whoever opened it, can settle it against what the feed says.
export default function CreateMarket({ onCreated }: { onCreated: () => void }) {
    const strk20 = useStrk20();
    const [open, setOpen] = useState(false);
    const [question, setQuestion] = useState("");
    const [labelText, setLabelText] = useState("Yes, No");
    const [hours, setHours] = useState("24");
    const [category, setCategory] = useState<string>(CATEGORIES[0]);
    const [feed, setFeed] = useState(false);
    const [ticker, setTicker] = useState<string>(PAIRS[0].ticker);
    const [thresholdText, setThresholdText] = useState("");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const labels = labelText.split(",").map((label) => label.trim()).filter(Boolean);
    const hoursOpen = Number(hours);
    const pair = PAIRS.find((candidate) => candidate.ticker === ticker) ?? PAIRS[0];
    const threshold = parseThreshold(thresholdText, pair.decimals);
    const boundToFeed = feed && strk20.hasResolver;
    const ready =
        question.trim().length > 0 &&
        labels.length >= 2 &&
        labels.length <= MAX_OUTCOMES &&
        Number.isFinite(hoursOpen) &&
        hoursOpen > 0 &&
        strk20.isConnected &&
        strk20.hasMarket &&
        // A price question has exactly two sides: at or above the line, and below it.
        (!boundToFeed || (labels.length === 2 && threshold !== null));

    async function create() {
        if (!ready) return;
        setResult(null);
        setBusy(true);
        try {
            const closeAt = Math.floor(Date.now() / 1000) + Math.round(hoursOpen * 3600);
            const call =
                boundToFeed && threshold !== null
                    ? openPriceMarketCall(
                        strk20.resolverAddress,
                        question.trim(),
                        labels[0],
                        labels[1],
                        closeAt,
                        category,
                        pair.ticker,
                        threshold
                    )
                    : createMarketCall(
                        strk20.marketAddress,
                        question.trim(),
                        labels,
                        strk20.address,
                        closeAt,
                        category
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
            <div className={styles.feedFields}>
                <select
                    className={styles.textInput}
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    aria-label="Category"
                >
                    {CATEGORIES.map((option) => (
                        <option key={option} value={option}>
                            {option}
                        </option>
                    ))}
                    <option value="">Uncategorised</option>
                </select>
                <input
                    className={styles.textInput}
                    value={hours}
                    onChange={(event) => setHours(event.target.value)}
                    inputMode="decimal"
                    placeholder="Hours open"
                    aria-label="Hours the market stays open"
                />
            </div>

            {strk20.hasResolver ? (
                <label className={styles.feedToggle}>
                    <input type="checkbox" checked={feed} onChange={(event) => setFeed(event.target.checked)} />
                    Settle from a Pragma price feed
                </label>
            ) : null}

            {boundToFeed ? (
                <div className={styles.feedFields}>
                    <select
                        className={styles.textInput}
                        value={ticker}
                        onChange={(event) => setTicker(event.target.value)}
                        aria-label="Price pair"
                    >
                        {PAIRS.map((candidate) => (
                            <option key={candidate.ticker} value={candidate.ticker}>
                                {candidate.ticker}
                            </option>
                        ))}
                    </select>
                    <input
                        className={styles.textInput}
                        value={thresholdText}
                        onChange={(event) => setThresholdText(event.target.value)}
                        inputMode="decimal"
                        placeholder={`Threshold in ${ticker.split("/")[1]}`}
                        aria-label="Threshold price"
                    />
                </div>
            ) : null}

            <div className={styles.createNote}>
                {boundToFeed ? (
                    <>
                        {labels[0] ?? "the first outcome"} wins if the {ticker} median is at or above{" "}
                        {thresholdText || "the threshold"} when the market closes, otherwise{" "}
                        {labels[1] ?? "the second"}. The feed decides it, anyone can send the
                        settlement and nobody can settle it any other way.
                    </>
                ) : (
                    <>
                        {labels.length} outcomes, betting closes in {hours || "0"}h. You are the
                        resolver: you settle it once it closes, or void it and every stake is
                        refundable.
                    </>
                )}
            </div>
            <button className={styles.btnCta} disabled={!ready || busy} onClick={create}>
                {busy ? "Submitting…" : "Open market"}
            </button>
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
