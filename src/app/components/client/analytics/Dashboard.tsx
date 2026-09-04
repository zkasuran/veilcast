"use client";

import { useMemo } from "react";
import Link from "next/link";
import styles from "../../../neon.module.css";
import { deriveAnalytics, boardAnalytics } from "@/utils/analytics";
import { formatStrk } from "@/utils/veilcast";
import { useBoardContext } from "../market/BoardContext";
import { useWatchlist } from "./useWatchlist";
import VerdictPill from "./VerdictPill";
import LiveTicker from "./LiveTicker";

/// The home dashboard: a live set of on-chain facts, no server, no key, no model. It turns the public
/// board into the few numbers a visitor actually reads before deciding to trade.
export default function Dashboard({ onExplore }: { onExplore?: () => void }) {
    const board = useBoardContext();
    const watch = useWatchlist();

    const analytics = useMemo(() => {
        const reads = deriveAnalytics(board.markets);
        return { reads, meta: boardAnalytics(reads) };
    }, [board.markets]);

    const { reads, meta } = analytics;
    const byCategory = useMemo(() => {
        const counts = new Map<string, number>();
        for (const read of reads) {
            const key = read.category || "Other";
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    }, [reads]);
    const maxCategory = byCategory.reduce((max, [, count]) => Math.max(max, count), 1);
    const watchCount = watch.ids.length;

    return (
        <>
            <section className={styles.hero}>
                <span className={styles.heroKicker}>
                    <span className={styles.heroKickerDot} />
                    On-chain · static · keyless
                </span>
                <h1 className={styles.heroTitle}>
                    Private markets,{" "}
                    <span className={styles.heroAccent}>public odds.</span>
                </h1>
                <p className={styles.heroDesc}>
                    The volume is public so the price means something. The bettors are anonymous so it
                    stays honest. Trade it yourself, or hand an agent a mandate the contract keeps it
                    honest with — nowhere for it to put a different recipient.
                </p>
                <div className={styles.heroBadges}>
                    <span className={styles.heroBadge}>
                        <b>{reads.length}</b> live reads
                    </span>
                    <span className={styles.heroBadge}>
                        <b>{formatStrk(meta.totalPot)}</b> STRK on the board
                    </span>
                    <span className={styles.heroBadge}>
                        <b>0 keys · 0 AI · 0 server</b>
                    </span>
                </div>
                <div className={styles.heroCtaRow}>
                    <button className={styles.heroCta} onClick={() => onExplore?.()}>
                        Enter the board
                    </button>
                    <Link href={`/market/?id=${meta.bestValue?.marketId ?? "0"}`} className={styles.heroCtaGhost}>
                        Best edge
                    </Link>
                </div>
            </section>

            <LiveTicker reads={reads} />

            <section className={styles.section}>
                <div className={styles.statGrid}>
                    <Stat label="Open board" value={String(reads.length)} hint={board.polling ? "polling every 15s" : "frozen"} />
                    <Stat label="Total staked" value={`${formatStrk(meta.totalPot)}`} hint="STRK across live markets" />
                    <Stat label="Aggregate read" value={shortVerdict(meta.aggregate)} tone={verdictTone(meta.aggregate)} hint={`${meta.aggregateCount} market${meta.aggregateCount === 1 ? "" : "s"} agree`} />
                    <Stat label="Your shortlist" value={String(watchCount)} hint={watchCount > 0 ? "tracked per browser" : "tap ☆ on any market"} />
                    <Stat
                        label="Best edge"
                        value={meta.bestValue ? `+${(meta.bestValue.edge * 100).toFixed(1)}%` : "—"}
                        tone="up"
                        hint={meta.bestValue ? `#${meta.bestValue.marketId} · ${meta.bestValue.label}` : "no liquid read yet"}
                    />
                </div>

                <div className={styles.dashGrid}>
                    <Feature title="Busiest" value={meta.busiest ? formatStrk(meta.busiest.pot) : "—"} unit="STRK" footnote={meta.busiest?.question} href={meta.busiest ? `/market/?id=${meta.busiest.marketId}` : undefined}>
                        {meta.busiest ? <VerdictPill verdict={meta.busiest.verdict} /> : null}
                    </Feature>
                    <Feature title="Best value" value={meta.bestValue ? `${(meta.bestValue.edge * 100).toFixed(1)}%` : "—"} unit="edge" footnote={meta.bestValue?.question} href={meta.bestValue ? `/market/?id=${meta.bestValue.marketId}` : undefined}>
                        {meta.bestValue ? <VerdictPill verdict={meta.bestValue.verdict} /> : null}
                    </Feature>
                    <Feature title="Riskiest" value={meta.riskiest ? `${Math.round(meta.riskiest.risk * 100)}%` : "—"} unit="risk" footnote={meta.riskiest?.question} href={meta.riskiest ? `/market/?id=${meta.riskiest.marketId}` : undefined}>
                        {meta.riskiest ? <VerdictPill verdict={meta.riskiest.verdict} /> : null}
                    </Feature>
                    <Feature title="Spread" value={byCategory.length ? String(byCategory.length) : "—"} unit="categories" footnote="public board distribution" noLink>
                        <CategoryBars items={byCategory} max={maxCategory} />
                    </Feature>
                </div>

                <p className={styles.sectionSub}>
                    <b>How to read this:</b> every number is derived from public on-chain volume. Nothing
                    is a prediction, and nothing claims to be one. A thin book produces a low-conviction
                    verdict, not a strong one.
                </p>
            </section>
        </>
    );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "up" | "down" | "neutral" }) {
    return (
        <div className={styles.statCard}>
            <span className={styles.statLabel}>{label}</span>
            <span className={`${styles.statValue} ${tone ? (tone === "up" ? styles.statUp : tone === "down" ? styles.statDown : styles.statNeutral) : ""}`}>
                {value}
            </span>
            {hint ? <span className={styles.statHint}>{hint}</span> : null}
        </div>
    );
}

function Feature({
    title,
    value,
    unit,
    footnote,
    href,
    children,
    noLink,
}: {
    title: string;
    value: string;
    unit: string;
    footnote?: string;
    href?: string;
    children?: React.ReactNode;
    noLink?: boolean;
}) {
    const body = (
        <>
            <div className={styles.dashHead}>
                <span className={styles.dashTitle}>{title}</span>
                {children}
            </div>
            <span className={`${styles.dashValue} ${styles.dashValueSmall}`}>{value} <small className={styles.dashFoot}>{unit}</small></span>
            <p className={styles.dashFoot}>{footnote ?? "No read yet"}</p>
        </>
    );
    return noLink ? (
        <article className={styles.dashCard}>{body}</article>
    ) : (
        <Link href={href ?? "/#markets"} className={styles.dashCard}>
            {body}
        </Link>
    );
}

function CategoryBars({ items, max }: { items: [string, number][]; max: number }) {
    return (
        <div className={styles.dashSpark}>
            {items.map(([name, count]) => (
                <span
                    key={name}
                    className={styles.sparkBar}
                    style={{ height: `${Math.max(12, (count / max) * 100)}%` }}
                    title={`${name}: ${count}`}
                />
            ))}
            {items.length === 0 ? <span className={`${styles.sparkBar} ${styles.sparkBarDim}`} style={{ width: "100%" }} /> : null}
        </div>
    );
}

function shortVerdict(verdict: string): string {
    if (verdict === "Strong YES") return "Strong YES";
    if (verdict === "Strong NO") return "Strong NO";
    return verdict;
}

function verdictTone(verdict: string): "up" | "down" | "neutral" {
    if (verdict === "Strong YES" || verdict === "YES") return "up";
    if (verdict === "Strong NO" || verdict === "NO") return "down";
    return "neutral";
}
