"use client";

import Link from "next/link";
import styles from "../../../neon.module.css";
import type { MarketAnalysis } from "@/utils/analytics";

/// A horizontal strip of the strongest reads. It is a dashboard ornament, not a recommendation:
/// tap any grain to see the full facet breakdown on that market's page.
export default function LiveTicker({ reads }: { reads: MarketAnalysis[] }) {
    const top = reads.slice(0, 10);
    if (top.length === 0) return null;
    return (
        <div className={styles.tickerBar} aria-label="Top market reads">
            <span className={styles.tickerLabel}>Radar</span>
            <div className={styles.tickerScroller}>
                {top.map((read) => (
                    <Link key={read.marketId} className={styles.tickerItem} href={`/market/?id=${read.marketId}`}>
                        <span>#{read.marketId}</span>
                        <span>{read.label}</span>
                        <span className={styles.tickerPct}>
                            {Math.round(read.implied * 100)}% · {read.score}
                        </span>
                    </Link>
                ))}
            </div>
        </div>
    );
}
