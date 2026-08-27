"use client";

import type { WALLET_API } from "@starknet-io/types-js";
import { type Call, num } from "starknet";
import * as constants from "@/utils/constants";
import { formatStrk } from "@/utils/veilcast";
import { useStoreWallet } from "../../Wallet/walletContext";
import { useFrontendProvider } from "../provider/providerContext";

export type ResultRow = { label: string; value: string; hash?: string };

/// A finished, in-flight or failed action, rendered as a receipt card rather than raw JSON.
export type ActionResult = {
    status: "pending" | "ok" | "error";
    title: string;
    rows?: ResultRow[];
    note?: string;
};

export type SetResult = (result: ActionResult | null) => void;

/// Shortens a felt for display ("0x1dc5a1c…927a").
export function shortHex(value: string): string {
    const hex = num.toHex(value);
    return hex.length <= 13 ? hex : `${hex.slice(0, 7)}…${hex.slice(-4)}`;
}

export function errorResult(message: string): ActionResult {
    return { status: "error", title: "Action failed", note: message };
}

export function errorMessage(error: unknown): string {
    const failure = error as { message?: string } | undefined;
    return failure?.message ?? String(error);
}

/// "Accepted on L2 · Succeeded", from the receipt's two status fields.
function prettyStatus(finality?: string, execution?: string): string {
    const settled =
        finality === "ACCEPTED_ON_L2" ? "Accepted on L2"
            : finality === "ACCEPTED_ON_L1" ? "Accepted on L1"
            : finality === "RECEIVED" ? "Received"
            : finality ?? "";
    const ran = execution === "SUCCEEDED" ? "Succeeded" : execution === "REVERTED" ? "Reverted" : "";
    return [settled, ran].filter(Boolean).join(" · ") || "Confirmed";
}

/// Turns a raw receipt into a readable card: what moved, whether it stuck, the fee, the hash.
function receiptToResult(raw: unknown, txHash: string, amountLabel: string): ActionResult {
    const receipt = (raw as { value?: Record<string, unknown> })?.value ?? (raw as Record<string, unknown>);
    const execution = receipt?.execution_status as string | undefined;
    const rows: ResultRow[] = [];
    if (amountLabel) rows.push({ label: "Amount", value: amountLabel });
    rows.push({ label: "Status", value: prettyStatus(receipt?.finality_status as string, execution) });
    const feeRaw = (receipt?.actual_fee as { amount?: string })?.amount ?? receipt?.actual_fee;
    try {
        if (feeRaw !== undefined && feeRaw !== null) {
            rows.push({ label: "Network fee", value: `${formatStrk(num.toBigInt(feeRaw as string))} STRK` });
        }
    } catch {
        // An unparseable fee is not worth failing a confirmed transaction over.
    }
    if (Array.isArray(receipt?.events)) {
        rows.push({ label: "Events", value: String((receipt.events as unknown[]).length) });
    }
    rows.push({ label: "Transaction", value: shortHex(txHash), hash: txHash });
    const reverted = execution === "REVERTED";
    return {
        status: reverted ? "error" : "ok",
        title: reverted ? "Transaction reverted" : "Transaction confirmed",
        rows,
    };
}

/// Everything a panel needs to talk to the pool and to the market on the current network, plus the
/// two ways this app sends a transaction: a STRK20 action list through the wallet's privacy path,
/// and an ordinary public call for the market's open admin (create, resolve, void).
export function useStrk20() {
    const providerIndex = useFrontendProvider((state) => state.currentFrontendProviderIndex);
    const walletAccount = useStoreWallet((state) => state.myWalletAccount);
    const address = useStoreWallet((state) => state.address);
    const isConnected = useStoreWallet((state) => state.isConnected);

    const networkName = constants.Strk20Networks[providerIndex];
    // myWalletAccount.provider is fixed at connect time and can point at the wrong network, so
    // every read and every receipt goes through the provider that tracks the current one.
    const provider = constants.myFrontendProviders[providerIndex];
    const marketAddress = constants.marketForIndex(providerIndex);
    const resolverAddress = constants.resolverForIndex(providerIndex);
    const committeeAddress = constants.committeeForIndex(providerIndex);
    const leverageAddress = constants.leverageForIndex(providerIndex);

    async function track(txHash: string, setResult: SetResult, amountLabel: string) {
        setResult({
            status: "pending",
            title: "Waiting for confirmation…",
            rows: [
                ...(amountLabel ? [{ label: "Amount", value: amountLabel }] : []),
                { label: "Transaction", value: shortHex(txHash), hash: txHash },
            ],
        });
        try {
            // Pool transactions verify a STARK proof on-chain, so the budget is long.
            const receipt = await provider.waitForTransaction(txHash, { retries: 400, retryInterval: 3000 });
            setResult(receiptToResult(receipt, txHash, amountLabel));
        } catch (error) {
            setResult({
                status: "error",
                title: "Could not confirm transaction",
                rows: [{ label: "Transaction", value: shortHex(txHash), hash: txHash }],
                note: errorMessage(error),
            });
        }
    }

    /// Submits a STRK20 action list. Returns the transaction hash, or undefined if the wallet
    /// refused, so a caller can key follow-up work on the bet or claim actually being sent.
    async function submit(
        actions: WALLET_API.STRK20_ACTION[],
        setResult: SetResult,
        amountLabel: string
    ): Promise<string | undefined> {
        if (!walletAccount) {
            setResult(errorResult("No wallet connected."));
            return undefined;
        }
        let txHash: string;
        try {
            txHash = (await walletAccount.strk20InvokeTransaction(actions)).transaction_hash;
        } catch (error) {
            setResult(errorResult(errorMessage(error)));
            return undefined;
        }
        await track(txHash, setResult, amountLabel);
        return txHash;
    }

    /// Sends an ordinary public call from the connected account. Creating, resolving and voiding a
    /// market are deliberately public: they are the market's terms, and hiding them would make the
    /// board unverifiable.
    async function execute(
        calls: Call[],
        setResult: SetResult,
        label: string
    ): Promise<string | undefined> {
        if (!walletAccount) {
            setResult(errorResult("No wallet connected."));
            return undefined;
        }
        let txHash: string;
        try {
            txHash = (await walletAccount.execute(calls)).transaction_hash;
        } catch (error) {
            setResult(errorResult(errorMessage(error)));
            return undefined;
        }
        await track(txHash, setResult, label);
        return txHash;
    }

    return {
        providerIndex,
        provider,
        networkName,
        isStrk20Network: networkName !== undefined,
        marketAddress,
        hasMarket: constants.isDeployedAt(marketAddress),
        resolverAddress,
        hasResolver: constants.isDeployedAt(resolverAddress),
        committeeAddress,
        hasCommittee: constants.isDeployedAt(committeeAddress),
        leverageAddress,
        hasLeverage: constants.isDeployedAt(leverageAddress),
        address,
        isConnected,
        walletAccount,
        submit,
        execute,
    };
}
