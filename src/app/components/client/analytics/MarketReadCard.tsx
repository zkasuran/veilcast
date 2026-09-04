"use client";

import Link from "next/link";
import styles from "../../../neon.module.css";
import uni from "../../../uni.module.css";
import type { MarketAnalysis } from "@/utils/analytics";
import { formatStrk } from "@/utils/veilcast";
import VerdictPill from "./VerdictPill";
import WatchStar from "./WatchStar";

/// One deterministic read of a market, expanded with the five facets that produced it. It is the
/// analytics surface's workhorse: the verdict, the confidence, the score, the edge and every facet
/// note, all derived from the public book.
export default function MarketAnalysisCard({
    read,
    watched,
    onToggleWatch,
}: {
    read: MarketAnalysis;
    watched: boolean;
    onToggleWatch: (id: number) => void;
}) {
    const lensTone = (score: number) =>
        score >= 62 ? styles.lensFillGood : score <= 38 ? styles.lensFillBad : "";

    return (
        <article className={styles.radarRow}>
            <div className={styles.radarMain}>
                <Link href={`/market/?id=${read.marketId}`} className={uni.marketQuestionLink}>
                    <span className={styles.radarQ}>{read.question}</span>
                </Link>
                <div className={styles.radarMeta}>
                    <span>#{read.marketId}</span>
                    <span>·</span>
                    <span>
                        <b>{read.label}</b> at {Math.round(read.implied * 100)}% ({read.payout.toFixed(2)}x)
                    </span>
                    <span>·</span>
                    <span>{formatStrk(read.volume)} STRK</span>
                    <span>·</span>
                    <span>{read.hoursLeft <= 24 ? `${Math.round(read.hoursLeft)}h` : `${Math.round(read.hoursLeft / 24)}d`} left</span>
                    <span>·</span>
                    <span>
                        edge <b className={read.edge >= 0 ? uni.statUp : uni.statDown}>
                            {read.edge >= 0 ? "+" : ""}
                            {(read.edge * 100).toFixed(1)}%
                        </b>
                    </span>
                </div>
                <div className={styles.lensList}>
                    {read.lenses.map((lens) => (
                        <div key={lens.id} className={styles.lensRow} title={lens.note}>
                            <span className={styles.lensName}>{lens.name}</span>
                            <span className={styles.lensBar}>
                                <span
                                    className={`${styles.lensFill} ${lensTone(lens.score)}`}
                                    style={{ width: `${lens.score}%` }}
                                />
                            </span>
                            <span className={styles.lensScore}>{lens.score}</span>
                        </div>
                    ))}
                </div>
                <p className={styles.dashFoot}>{read.oneLiner}</p>
            </div>
            <div className={styles.radarRight}>
                <VerdictPill verdict={read.verdict} />
                <span className={styles.radarScore}>
                    <span className={styles.radarScoreBar}>
                        <span className={styles.radarScoreFill} style={{ width: `${read.score}%` }} />
                    </span>
                    {read.score}
                </span>
                <span className={styles.dashFoot}>
                    {Math.round(read.confidence * 100)}% conviction
                </span>
                <WatchStar watched={watched} onToggle={() => onToggleWatch(read.marketId)} />
            </div>
        </article>
    );
}
