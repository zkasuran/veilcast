"use client";

import { useState } from "react";
import { num, validateAndParseAddress } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import styles from "../../../uni.module.css";
import { addrSTRK } from "@/utils/constants";
import { formatStrk, parseStrk } from "@/utils/veilcast";
import SelectWallet from "../WalletHandle/SelectWallet";
import AmountInput from "./AmountInput";
import ResultCard from "./ResultCard";
import { type ActionResult, errorMessage, errorResult, shortHex, useStrk20 } from "./useStrk20";

/// The four pool actions Veilcast is built on: move STRK in, move it privately, move it out, and
/// read what the pool holds for you. A bet spends a shielded balance, so this is where one starts.
export type PoolAction = "shield" | "send" | "unshield" | "balances";

const COPY: Record<PoolAction, { label: string; hint: string; cta: string }> = {
    shield: {
        label: "You're shielding",
        hint: "Public deposit into the privacy pool, screened on-chain",
        cta: "Shield",
    },
    send: { label: "You're sending", hint: "Private transfer inside the pool", cta: "Send privately" },
    unshield: { label: "You're unshielding", hint: "Withdraw to a public address", cta: "Unshield" },
    balances: { label: "Shielded balances", hint: "What the pool holds for you", cta: "Query balances" },
};

export default function PoolPanel({ action }: { action: PoolAction }) {
    const strk20 = useStrk20();
    const [amount, setAmount] = useState("1");
    const [recipient, setRecipient] = useState("");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const copy = COPY[action];
    const stake = parseStrk(amount);
    const target = recipient.trim() === "" ? strk20.address : recipient.trim();
    const targetOk = (() => {
        if (action === "shield" || action === "balances") return true;
        try {
            return num.toBigInt(validateAndParseAddress(target)) !== 0n;
        } catch {
            return false;
        }
    })();
    const ready = strk20.isStrk20Network && targetOk && (action === "balances" || stake !== null);

    async function run() {
        setResult(null);
        setBusy(true);
        try {
            if (action === "balances") {
                await queryBalances();
                return;
            }
            if (stake === null) return;
            const amountHex = num.toHex(stake);
            const actions: WALLET_API.STRK20_ACTION[] =
                action === "shield"
                    ? [{ type: "deposit", token: addrSTRK, amount: amountHex }]
                    : action === "send"
                    ? [{ type: "transfer", token: addrSTRK, amount: amountHex, recipient: target }]
                    : [{ type: "withdraw", token: addrSTRK, amount: amountHex, recipient: target }];
            await strk20.submit(actions, setResult, `${formatStrk(stake)} STRK`);
        } finally {
            setBusy(false);
        }
    }

    async function queryBalances() {
        if (!strk20.walletAccount) {
            setResult(errorResult("No wallet connected."));
            return;
        }
        try {
            // An empty token list asks for every shielded balance the wallet knows about.
            const balances = await strk20.walletAccount.strk20Balances([]);
            if (!balances.length) {
                setResult({
                    status: "ok",
                    title: "No shielded balances",
                    note: "This account holds nothing in the privacy pool yet. Shield some STRK first.",
                });
                return;
            }
            setResult({
                status: "ok",
                title: "Shielded balances",
                rows: balances.map((entry) => ({
                    label: num.toBigInt(entry.token) === num.toBigInt(addrSTRK) ? "STRK" : shortHex(entry.token),
                    value: formatStrk(num.toBigInt(entry.balance)),
                })),
            });
        } catch (error) {
            setResult(errorResult(errorMessage(error)));
        }
    }

    return (
        <div className={styles.panel}>
            {action === "balances" ? (
                <div className={styles.inputBlock}>
                    <div className={styles.inputLabel}>{copy.label}</div>
                    <div className={styles.inputMain}>
                        <div className={styles.bigValue}>All</div>
                        <span className={styles.tokenPill}>tokens</span>
                    </div>
                    <div className={styles.subLine}>
                        <span>{copy.hint}</span>
                    </div>
                </div>
            ) : (
                <AmountInput
                    label={copy.label}
                    value={amount}
                    onChange={setAmount}
                    hint={copy.hint}
                    detail={stake === null ? "enter an amount" : `${formatStrk(stake)} STRK`}
                />
            )}

            {action === "send" || action === "unshield" ? (
                <input
                    className={styles.textInput}
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value)}
                    placeholder={strk20.address ? `Recipient (default: you, ${shortHex(strk20.address)})` : "Recipient address"}
                    aria-label="Recipient address"
                    spellCheck={false}
                />
            ) : null}

            <div className={styles.feeRow}>
                <span>Network</span>
                <span className={`${styles.feeVal} ${strk20.isStrk20Network ? styles.netOk : styles.netBad}`}>
                    <span className={`${styles.netDot} ${strk20.isStrk20Network ? styles.netOkDot : styles.netBadDot}`} />
                    {strk20.networkName ?? "Unsupported"}
                </span>
            </div>

            {!strk20.isStrk20Network ? (
                <div className={styles.warn}>
                    The STRK20 pool lives on Mainnet and Sepolia. Switch your wallet network.
                </div>
            ) : null}
            {strk20.isStrk20Network && !targetOk ? (
                <div className={styles.warn}>That recipient is not a Starknet address.</div>
            ) : null}

            {strk20.isConnected ? (
                <button className={styles.btnCta} disabled={!ready || busy} onClick={run}>
                    {busy ? "Working…" : copy.cta}
                </button>
            ) : (
                <SelectWallet variant="ctaBig" />
            )}

            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
