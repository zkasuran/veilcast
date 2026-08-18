"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { MAX_JURORS, openCommitteeMarketCall, parseJurors } from "@/utils/committee";
import { CATEGORIES } from "@/utils/discovery";
import { MAX_FEE_BPS, createMarketCall } from "@/utils/market";
import { PAIRS, openPriceMarketCall, parseThreshold } from "@/utils/resolver";
import { MAX_OUTCOMES } from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

/// How a market will be settled, which is the one real choice the opener makes.
///
/// "you" is the plain resolver: the opener settles it. "feed" binds it to Pragma and takes the
/// decision away from everyone. "committee" hands it to a named jury. The last two are only offered
/// when their contract is deployed on this network.
type Mode = "you" | "feed" | "committee";

/// Opens a market, by whichever settlement route the opener picks.
export default function CreateMarket({ onCreated }: { onCreated: () => void }) {
    const strk20 = useStrk20();
    const [open, setOpen] = useState(false);
    const [question, setQuestion] = useState("");
    const [labelText, setLabelText] = useState("Yes, No");
    const [hours, setHours] = useState("24");
    const [category, setCategory] = useState<string>(CATEGORIES[0]);
    const [mode, setMode] = useState<Mode>("you");
    const [ticker, setTicker] = useState<string>(PAIRS[0].ticker);
    const [thresholdText, setThresholdText] = useState("");
    const [jurorText, setJurorText] = useState("");
    const [quorumText, setQuorumText] = useState("2");
    const [feePercent, setFeePercent] = useState("0");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const labels = labelText.split(",").map((label) => label.trim()).filter(Boolean);
    const hoursOpen = Number(hours);
    const pair = PAIRS.find((candidate) => candidate.ticker === ticker) ?? PAIRS[0];
    const threshold = parseThreshold(thresholdText, pair.decimals);
    // A percent in the form, basis points on-chain. 5% is the contract's cap.
    const feeBps = Math.round(Number(feePercent) * 100);
    const feeOk = Number.isFinite(feeBps) && feeBps >= 0 && feeBps <= MAX_FEE_BPS;

    const { jurors, invalid: badJurors } = parseJurors(jurorText);
    const quorum = Math.round(Number(quorumText));
    const feedReady = labels.length === 2 && threshold !== null;
    const committeeReady =
        jurors.length >= 1 &&
        jurors.length <= MAX_JURORS &&
        badJurors.length === 0 &&
        Number.isInteger(quorum) &&
        quorum >= 1 &&
        quorum <= jurors.length;

    const ready =
        question.trim().length > 0 &&
        labels.length >= 2 &&
        labels.length <= MAX_OUTCOMES &&
        Number.isFinite(hoursOpen) &&
        hoursOpen > 0 &&
        feeOk &&
        strk20.isConnected &&
        strk20.hasMarket &&
        (mode !== "feed" || feedReady) &&
        (mode !== "committee" || committeeReady);

    async function create() {
        if (!ready) return;
        setResult(null);
        setBusy(true);
        try {
            const closeAt = Math.floor(Date.now() / 1000) + Math.round(hoursOpen * 3600);
            const call = buildCall(closeAt);
            const txHash = await strk20.execute([call], setResult, question.trim());
            if (txHash) {
                setQuestion("");
                onCreated();
            }
        } finally {
            setBusy(false);
        }
    }

    function buildCall(closeAt: number) {
        if (mode === "feed" && threshold !== null) {
            return openPriceMarketCall(
                strk20.resolverAddress,
                question.trim(),
                labels[0],
                labels[1],
                closeAt,
                category,
                pair.ticker,
                threshold,
                feeBps
            );
        }
        if (mode === "committee") {
            return openCommitteeMarketCall(
                strk20.committeeAddress,
                question.trim(),
                labels,
                closeAt,
                category,
                feeBps,
                jurors,
                quorum
            );
        }
        return createMarketCall(
            strk20.marketAddress,
            question.trim(),
            labels,
            strk20.address,
            closeAt,
            category,
            feeBps,
            strk20.address
        );
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
                <input
                    className={styles.textInput}
                    value={feePercent}
                    onChange={(event) => setFeePercent(event.target.value)}
                    inputMode="decimal"
                    placeholder="Fee %"
                    aria-label="Your fee, as a percent of the pot"
                />
            </div>

            {!feeOk ? (
                <div className={styles.warn}>
                    A fee has to be between 0 and {MAX_FEE_BPS / 100}% of the pot.
                </div>
            ) : null}

            <label className={styles.fieldLabel}>How it settles</label>
            <select
                className={styles.textInput}
                value={mode}
                onChange={(event) => setMode(event.target.value as Mode)}
                aria-label="How the market settles"
            >
                <option value="you">You settle it (you are the resolver)</option>
                {strk20.hasResolver ? <option value="feed">A Pragma price feed settles it</option> : null}
                {strk20.hasCommittee ? <option value="committee">A jury settles it</option> : null}
            </select>

            {mode === "feed" ? (
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

            {mode === "committee" ? (
                <>
                    <textarea
                        className={styles.textArea}
                        value={jurorText}
                        onChange={(event) => setJurorText(event.target.value)}
                        placeholder="Juror addresses, one per line"
                        aria-label="Juror addresses"
                        rows={3}
                    />
                    <input
                        className={styles.textInput}
                        value={quorumText}
                        onChange={(event) => setQuorumText(event.target.value)}
                        inputMode="numeric"
                        placeholder="Votes needed to settle"
                        aria-label="Quorum"
                    />
                    {badJurors.length > 0 ? (
                        <div className={styles.warn}>Not a Starknet address: {badJurors.join(", ")}</div>
                    ) : null}
                    {jurors.length > 0 && !committeeReady && badJurors.length === 0 ? (
                        <div className={styles.warn}>
                            The quorum has to be between 1 and the {jurors.length} jurors.
                        </div>
                    ) : null}
                </>
            ) : null}

            <div className={styles.createNote}>
                {settlementNote(mode, { labels, ticker, thresholdText, jurors: jurors.length, quorum })}
                {feeBps > 0
                    ? ` Your fee is ${feeBps / 100}% of the pot, charged once when the market settles, shown on the board from the moment it opens. A void market charges nothing.`
                    : " No fee: the winning side splits the whole pot."}
            </div>
            <button className={styles.btnCta} disabled={!ready || busy} onClick={create}>
                {busy ? "Submitting…" : "Open market"}
            </button>
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}

function settlementNote(
    mode: Mode,
    { labels, ticker, thresholdText, jurors, quorum }: {
        labels: string[];
        ticker: string;
        thresholdText: string;
        jurors: number;
        quorum: number;
    }
): string {
    if (mode === "feed") {
        return `${labels[0] ?? "the first outcome"} wins if the ${ticker} median is at or above ${thresholdText || "the threshold"} when the market closes, otherwise ${labels[1] ?? "the second"}. The feed decides it, anyone can send the settlement and nobody can settle it any other way.`;
    }
    if (mode === "committee") {
        return `A jury of ${jurors || "your"} named jurors settles this, ${quorum} of them to agree. The jury and every vote are public. A panel that deadlocks cannot settle it, so it falls through to the 30-day public void.`;
    }
    return `${labels.length} outcomes. You are the resolver: you settle it once it closes, or void it and every stake is refundable.`;
}
