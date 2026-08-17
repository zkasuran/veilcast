"use client";

import styles from "../../../uni.module.css";
import { voyagerTxUrl } from "@/utils/constants";
import type { MarketEvent } from "@/utils/events";
import { formatStrk } from "@/utils/veilcast";
import { shortHex } from "../strk20/useStrk20";

/// What the chain says happened to this market, newest first.
///
/// Read it as the anonymity set: every row is an amount, an outcome and a key. The sender of each of
/// these transactions was the pool's relayer, so there is no address to show even if a row wanted to
/// show one. A bet and the claim that collects it share a coupon key, which links those two rows to
/// each other and to nothing else.
export default function ActivityFeed({
    events,
    labels,
    providerIndex,
    loading,
    error,
}: {
    events: MarketEvent[];
    labels: string[];
    providerIndex: number;
    loading: boolean;
    error: string;
}) {
    if (error) {
        return <div className={styles.warn}>Could not read the market's events: {error}</div>;
    }
    if (events.length === 0) {
        return (
            <div className={styles.notice}>
                {loading ? "Reading the market's events…" : "Nothing has happened here yet."}
            </div>
        );
    }

    const newestFirst = [...events].reverse();

    return (
        <div className={styles.feedList}>
            {newestFirst.map((event) => (
                <div key={`${event.txHash}-${event.kind}-${event.positionKey ?? event.outcome ?? ""}`} className={styles.feedItem}>
                    <span className={`${styles.feedKind} ${kindTone(event, styles)}`}>{kindLabel(event)}</span>
                    <span className={styles.feedText}>{describe(event, labels)}</span>
                    <a
                        className={styles.feedLink}
                        href={voyagerTxUrl(providerIndex, event.txHash)}
                        target="_blank"
                        rel="noreferrer"
                    >
                        block {event.blockNumber} ↗
                    </a>
                </div>
            ))}
        </div>
    );
}

function kindLabel(event: MarketEvent): string {
    return {
        created: "opened",
        bet: "bet",
        resolved: "resolved",
        void: "voided",
        claimed: "collected",
    }[event.kind];
}

function kindTone(event: MarketEvent, styleMap: Record<string, string>): string {
    if (event.kind === "resolved" || event.kind === "claimed") return styleMap.feedKindGreen;
    if (event.kind === "void") return styleMap.feedKindGrey;
    return styleMap.feedKindPink;
}

function describe(event: MarketEvent, labels: string[]): string {
    const outcome = event.outcome !== undefined ? (labels[event.outcome] ?? `outcome ${event.outcome}`) : "";
    if (event.kind === "bet") {
        return `${formatStrk(event.amount ?? 0n)} STRK on ${outcome}, coupon ${shortHex(event.positionKey ?? "0x0")}`;
    }
    if (event.kind === "claimed") {
        return `${formatStrk(event.amount ?? 0n)} STRK to coupon ${shortHex(event.positionKey ?? "0x0")}`;
    }
    if (event.kind === "resolved") {
        return `settled on ${outcome}, a pot of ${formatStrk(event.amount ?? 0n)} STRK`;
    }
    if (event.kind === "void") {
        return "cancelled, every stake refundable";
    }
    return "market opened";
}
