"use client";

import Link from "next/link";
import styles from "../../../uni.module.css";
import neon from "../../../neon.module.css";
import type { MarketEvent } from "@/utils/events";
import type { MarketView } from "@/utils/market";
import { useStrk20 } from "../strk20/useStrk20";
import { useBoardContext } from "./BoardContext";
import { useBoardActivity } from "./useBoardActivity";
import ActivityFeed from "./ActivityFeed";

/// The board's pulse: every recent on-chain event across all open and settled markets, newest first.
/// No identity is shown anywhere — each line is an amount plus a fresh coupon key, exactly as the
/// contract publishes it.
export default function ActivityPanel() {
    const board = useBoardContext();
    const strk20 = useStrk20();
    const { events, loading, error, reload } = useBoardActivity(board.lastUpdated);
    const byId = new Map(board.markets.map((view) => [view.id, view]));

    if (!strk20.hasMarket) {
        return (
            <div className={styles.panelWide}>
                <div className={styles.notice}>
                    No Veilcast market is deployed on {strk20.networkName ?? "this network"} yet, so
                    there is no activity to show.
                </div>
            </div>
        );
    }

    const grouped = groupByMarket(events, byId);

    return (
        <div className={styles.panelWide}>
            <div className={neon.sectionHead}>
                <div>
                    <h2 className={neon.sectionTitle}>Live feed</h2>
                    <p className={neon.sectionSub}>
                        Every event on the board, newest first. Amounts and coupon keys only — no
                        addresses, ever.
                    </p>
                </div>
                <button className={styles.btn} onClick={() => void reload()} disabled={loading}>
                    {loading ? "Reading chain…" : "Refresh"}
                </button>
            </div>
            {error ? <div className={styles.warn}>Could not read the event log: {error}</div> : null}

            {grouped.map((market) => (
                <section key={market.id} className={neon.section} style={{ gap: 10, marginBottom: 14 }}>
                    <div className={styles.detailHead}>
                        <Link href={`/market/?id=${market.id}`} className={styles.marketQuestionLink}>
                            #{market.id} · {market.question ?? `market ${market.id}`}
                        </Link>
                        <span className={styles.boardCount}>{market.events.length} events</span>
                    </div>
                    <ActivityFeed
                        events={market.events}
                        labels={market.labels}
                        providerIndex={strk20.providerIndex}
                        loading={loading}
                        error={error}
                    />
                </section>
            ))}

            {events.length === 0 && !loading && !error ? (
                <div className={neon.emptyCard}>
                    <b>No activity on this board yet.</b>
                    <br />
                    Place a bet or open a market and the flow appears here.
                </div>
            ) : null}
        </div>
    );
}

function groupByMarket(
    events: MarketEvent[],
    byId: Map<number, MarketView>
): { id: number; question?: string; labels: string[]; events: MarketEvent[] }[] {
    const groups = new Map<number, MarketEvent[]>();
    for (const event of events) {
        const bucket = groups.get(event.marketId) ?? [];
        bucket.push(event);
        groups.set(event.marketId, bucket);
    }
    return [...groups.entries()].map(([id, list]) => ({
        id,
        question: byId.get(id)?.question,
        labels: byId.get(id)?.labels ?? [],
        events: list,
    }));
}
