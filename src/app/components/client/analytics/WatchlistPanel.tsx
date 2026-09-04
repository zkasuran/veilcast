"use client";

import { useMemo } from "react";
import Link from "next/link";
import styles from "../../../neon.module.css";
import uni from "../../../uni.module.css";
import { deriveAnalytics, type MarketAnalysis } from "@/utils/analytics";
import type { MarketView } from "@/utils/market";
import { formatStrk } from "@/utils/veilcast";
import { useBoardContext } from "../market/BoardContext";
import { useWatchlist } from "./useWatchlist";
import MarketReadCard from "./MarketReadCard";

/// Your shortlist. Following a market is local, so two browsers (or two devices) can follow the same
/// on-chain board without anything else in common. A watched market that is still open gets the full
/// radar read; one that closed gets a simple link to its market page.
export default function WatchlistPanel() {
    const board = useBoardContext();
    const watch = useWatchlist();

    const readsByMarket = useMemo(() => {
        const map = new Map<number, MarketAnalysis>();
        for (const read of deriveAnalytics(board.markets)) {
            map.set(read.marketId, read);
        }
        return map;
    }, [board.markets]);

    const watched = board.markets.filter((view) => watch.has(view.id));

    return (
        <div className={uni.panelWide}>
            <div className={styles.sectionHead}>
                <div>
                    <h2 className={styles.sectionTitle}>Your shortlist</h2>
                    <p className={styles.sectionSub}>
                        Torch those ☆ on any market and it lands here. Stored only in this browser.
                    </p>
                </div>
                <span className={styles.watchCount}>★ {watch.ids.length} followed</span>
            </div>

            {board.error ? <div className={uni.warn}>Could not read the board: {board.error}</div> : null}
            {board.loading && board.markets.length === 0 ? (
                <div className={styles.radarList}>
                    <div className={styles.skeletonNeon} />
                    <div className={styles.skeletonNeon} />
                </div>
            ) : null}

            {watched.length === 0 && !board.loading ? (
                <div className={styles.emptyCard}>
                    <b>Nothing followed yet.</b>
                    <br />
                    Tap the ☆ on any market card or radar read to build a shortlist across sessions.
                </div>
            ) : (
                <div className={styles.radarList}>
                    {watched.map((view) =>
                        readsByMarket.has(view.id) ? (
                            <MarketReadCard
                                key={view.id}
                                read={readsByMarket.get(view.id)!}
                                watched
                                onToggleWatch={watch.toggle}
                            />
                        ) : (
                            <WatchedClosed key={view.id} view={view} onUnfollow={() => watch.toggle(view.id)} />
                        )
                    )}
                </div>
            )}
        </div>
    );
}

function WatchedClosed({ view, onUnfollow }: { view: MarketView; onUnfollow: () => void }) {
    return (
        <article className={styles.radarRow}>
            <div className={styles.radarMain}>
                <Link href={`/market/?id=${view.id}`} className={uni.marketQuestionLink}>
                    <span className={styles.radarQ}>{view.question}</span>
                </Link>
                <div className={styles.radarMeta}>
                    <span>#{view.id}</span>
                    <span>·</span>
                    <span>{view.state}</span>
                    <span>·</span>
                    <span>{formatStrk(view.pot)} STRK pot</span>
                </div>
            </div>
            <button className={uni.btn} onClick={onUnfollow}>
                Unfollow
            </button>
        </article>
    );
}
