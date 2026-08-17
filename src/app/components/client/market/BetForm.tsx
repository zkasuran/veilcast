"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { addrSTRK } from "@/utils/constants";
import { type MarketView, quotePayout } from "@/utils/market";
import {
    betActions,
    formatStrk,
    newCoupon,
    markCouponPlaced,
    parseStrk,
    payoutMultiple,
    saveCoupon,
} from "@/utils/veilcast";
import AmountInput from "../strk20/AmountInput";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

/// Stakes shielded STRK on one outcome.
///
/// The bet is a single pool transaction: the pool withdraws the stake into the market contract and
/// invokes it in the same breath, so the sender on-chain is the pool. The market is handed an
/// amount, an outcome and a fresh public key it has never seen before, and nothing else. That key
/// is the coupon: generated here, saved here, and nothing else can collect the payout.
export default function BetForm({
    view,
    outcome,
    onPlaced,
}: {
    view: MarketView;
    outcome: number;
    onPlaced: () => void;
}) {
    const strk20 = useStrk20();
    const [amount, setAmount] = useState("1");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const stake = parseStrk(amount);
    const label = view.labels[outcome] ?? `outcome ${outcome}`;
    const volume = view.volumes[outcome] ?? 0n;
    const multiple = stake === null ? 0 : payoutMultiple(volume, view.pot, stake, view.feeBps);
    const payout = stake === null ? 0n : quotePayout(view, outcome, stake);

    async function placeBet() {
        if (stake === null || !strk20.hasMarket) return;
        setResult(null);
        setBusy(true);
        try {
            // Saved before the wallet is asked for anything: this key is the position, and a tab
            // that dies mid-signature must not take the payout with it.
            const coupon = newCoupon(view.id, outcome, stake);
            saveCoupon(coupon);
            const txHash = await strk20.submit(
                betActions(addrSTRK, strk20.marketAddress, coupon),
                setResult,
                `${formatStrk(stake)} STRK on ${label}`
            );
            if (txHash) {
                markCouponPlaced(coupon.positionKey, txHash);
                onPlaced();
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.betForm}>
            <AmountInput
                label={`Betting on ${label}`}
                value={amount}
                onChange={setAmount}
                hint={stake === null ? "Enter a stake in STRK" : `Pays ${multiple.toFixed(2)}x if ${label} wins`}
                detail={stake === null ? "" : `${formatStrk(payout)} STRK back`}
                disabled={busy}
            />

            <div className={styles.splitNote}>
                <span className={styles.splitPublic}>
                    Public: {stake === null ? "the stake" : `${formatStrk(stake)} STRK`} on {label}
                </span>
                <span className={styles.splitPrivate}>Private: that it is you</span>
            </div>

            {strk20.isConnected ? (
                <button className={styles.btnCta} disabled={stake === null || busy} onClick={placeBet}>
                    {busy ? "Proving and submitting…" : "Place private bet"}
                </button>
            ) : (
                <div className={styles.warn}>Connect a wallet to bet.</div>
            )}

            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
