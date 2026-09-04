"use client";

import { useMemo, useState } from "react";
import styles from "../../../neon.module.css";
import uni from "../../../uni.module.css";
import type { MarketAnalysis } from "@/utils/analytics";
import { deriveAnalytics } from "@/utils/analytics";
import type { MarketView } from "@/utils/market";
import { useBoardContext } from "../market/BoardContext";
import { useWatchlist } from "./useWatchlist";
import MarketReadCard from "./MarketReadCard";

const VERDICTS = ["All", "Strong YES", "YES", "Neutral", "NO", "Strong NO"] as const;
type SortKey = "score" | "edge" | "volume" | "closing";

/// The radar: every open market read through five deterministic facets, ranked by conviction. It is
/// the closest thing this static app has to an "intelligence layer", and it is deliberately not an AI
/// layer — no model call, no API key, no opinion the visitor cannot reproduce.
export default function AnalyticsPanel() {
    const board = useBoardContext();
    const watch = useWatchlist();
    const [verdict, setVerdict] = useState<(typeof VERDICTS)[number]>("All");
    const [sort, setSort] = useState<SortKey>("score");

    const reads = useMemo(() => {
        const all = deriveAnalytics(board.markets);
        const filtered = verdict === "All" ? all : all.filter((read) => read.verdict === verdict);
        return sortReads(filtered, sort);
    }, [board.markets, verdict, sort]);

    return (
        <div className={uni.panelWide}>
            <div className={styles.boardToolbar}>
                <div className={styles.sectionHead}>
                    <div>
                        <h2 className={styles.sectionTitle}>Market radar</h2>
                        <p className={styles.sectionSub}>
                            Five on-chain facets per market, all derived from public volume. Filter,
                            sort, then follow the ones worth your attention.
                        </p>
                    </div>
                    <div className={styles.sectionActions}>
                        <button className={uni.btn} onClick={() => void board.refresh()} disabled={board.loading}>
                            {board.loading ? "Reading chain…" : "Refresh"}
                        </button>
                    </div>
                </div>
            </div>

            <div className={styles.filterRow}>
                {VERDICTS.map((value) => (
                    <button
                        key={value}
                        className={`${styles.filterPill} ${verdict === value ? styles.filterActive : ""}`}
                        onClick={() => setVerdict(value)}
                    >
                        {value}
                    </button>
                ))}
                <span style={{ flex: 1 }} />
                <select
                    className={uni.selectInput}
                    value={sort}
                    onChange={(event) => setSort(event.target.value as SortKey)}
                    aria-label="Sort the radar"
                >
                    <option value="score">Conviction</option>
                    <option value="edge">Best edge</option>
                    <option value="volume">Most volume</option>
                    <option value="closing">Closing soon</option>
                </select>
            </div>

            {board.error ? <div className={uni.warn}>Could not read the board: {board.error}</div> : null}
            {board.loading && board.markets.length === 0 ? (
                <div className={styles.radarList}>
                    <div className={styles.skeletonNeon} />
                    <div className={styles.skeletonNeon} />
                    <div className={styles.skeletonNeon} />
                </div>
            ) : null}

            {reads.length === 0 && !board.loading ? (
                <div className={styles.emptyCard}>
                    <b>{verdict === "All" ? "No liquid markets yet." : `No ${verdict} reads on the board.`}</b>
                    <br />
                    Open a market or switch the filter to see the radar.
                </div>
            ) : (
                <div className={styles.radarList}>
                    {reads.map((read) => (
                        <MarketReadCard
                            key={`${read.marketId}:${read.outcome}`}
                            read={read}
                            watched={watch.has(read.marketId)}
                            onToggleWatch={watch.toggle}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function sortReads(reads: MarketAnalysis[], sort: SortKey): MarketAnalysis[] {
    const sorted = [...reads];
    if (sort === "edge") {
        sorted.sort((left, right) => right.edge - left.edge || cmpBig(right.volume, left.volume));
    } else if (sort === "volume") {
        sorted.sort((left, right) => cmpBig(right.volume, left.volume) || right.score - left.score);
    } else if (sort === "closing") {
        sorted.sort((left, right) => left.hoursLeft - right.hoursLeft || right.score - left.score);
    } else {
        sorted.sort((left, right) => right.score - left.score || cmpBig(right.volume, left.volume));
    }
    return sorted;
}

function cmpBig(left: bigint, right: bigint): number {
    return left === right ? 0 : left > right ? 1 : -1;
}

// Kept importable by tests / tree-shaking without pulling the whole derive step in.
export type { MarketView };
