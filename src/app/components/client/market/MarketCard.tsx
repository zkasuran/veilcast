"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import styles from "../../../uni.module.css";
import { voyagerContractUrl } from "@/utils/constants";
import { categoryLabel } from "@/utils/discovery";
import type { MarketView } from "@/utils/market";
import { formatStrk, formatTimeLeft, impliedProbability, payoutMultiple } from "@/utils/veilcast";

const ONE_STRK = 10n ** 18n;

/// One market on the board: the question, a column per outcome carrying the public volume and the
/// odds that fall out of it, plus whatever the panel puts underneath (a bet form, the resolver's
/// controls, a feed's settlement).
///
/// Every number here is public by design. A market with hidden sizes cannot produce honest odds, so
/// what Veilcast hides is who is behind them, which is nowhere in this data.
export default function MarketCard({
    view,
    selectedOutcome,
    onSelectOutcome,
    providerIndex,
    marketAddress,
    detailHref,
    children,
}: {
    view: MarketView;
    selectedOutcome?: number;
    onSelectOutcome: (outcome: number | undefined) => void;
    providerIndex: number;
    marketAddress: string;
    /// Where the question links to. Absent on the market's own page, where it would link to itself.
    detailHref?: string;
    children?: ReactNode;
}) {
    const now = Math.floor(Date.now() / 1000);
    const closed = now >= view.closeAt;
    const bettable = view.state === "Open" && !closed;
    const statePill =
        view.state === "Resolved"
            ? { text: `resolved: ${view.labels[view.winningOutcome] ?? view.winningOutcome}`, tone: styles.pillGreen }
            : view.state === "Void"
            ? { text: "void: stakes refundable", tone: styles.pillGrey }
            : closed
            ? { text: "closed, awaiting resolution", tone: styles.pillGrey }
            : { text: `open · ${formatTimeLeft(view.closeAt, now)} left`, tone: styles.pillPink };

    return (
        <div className={styles.marketCard}>
            <div className={styles.marketHead}>
                <span className={styles.marketQuestion}>
                    {detailHref ? (
                        <Link className={styles.marketQuestionLink} href={detailHref}>
                            {view.question}
                        </Link>
                    ) : (
                        view.question
                    )}
                </span>
                <span className={`${styles.pill} ${statePill.tone}`}>{statePill.text}</span>
            </div>
            <div className={styles.marketTags}>
                <span className={styles.tag}>{categoryLabel(view.category)}</span>
                <span className={styles.tag}>
                    {view.labels.length === 2 ? "binary" : `${view.labels.length} outcomes`}
                </span>
            </div>

            <div className={styles.outcomes}>
                {view.labels.map((label, outcome) => {
                    const volume = view.volumes[outcome] ?? 0n;
                    const share = impliedProbability(volume, view.pot, view.labels.length);
                    const percent = Math.round(share * 100);
                    const won = view.state === "Resolved" && outcome === view.winningOutcome;
                    const lost = view.state === "Resolved" && outcome !== view.winningOutcome;
                    const selected = selectedOutcome === outcome;
                    return (
                        <button
                            key={outcome}
                            className={[
                                styles.outcome,
                                selected ? styles.outcomeSelected : "",
                                won ? styles.outcomeWon : "",
                                lost ? styles.outcomeLost : "",
                            ].join(" ")}
                            onClick={() => onSelectOutcome(selected ? undefined : outcome)}
                            disabled={!bettable}
                            title={bettable ? `Bet on ${label}` : "This market is not taking bets"}
                        >
                            <span className={styles.outcomeTop}>
                                <span className={styles.outcomeLabel}>{label}</span>
                                <span className={styles.outcomePercent}>{percent}%</span>
                            </span>
                            <span className={styles.outcomeBar}>
                                <span className={styles.outcomeFill} style={{ width: `${percent}%` }} />
                            </span>
                            <span className={styles.outcomeFoot}>
                                {formatStrk(volume)} STRK
                                {view.state === "Open"
                                    ? ` · pays ${payoutMultiple(volume, view.pot, ONE_STRK).toFixed(2)}x`
                                    : won
                                    ? " · winner"
                                    : ""}
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className={styles.marketFoot}>
                <span>market #{view.id}</span>
                <span>pot {formatStrk(view.pot)} STRK</span>
                <span>closes {new Date(view.closeAt * 1000).toLocaleString()}</span>
                <a
                    className={styles.marketLink}
                    href={voyagerContractUrl(providerIndex, marketAddress)}
                    target="_blank"
                    rel="noreferrer"
                >
                    contract ↗
                </a>
            </div>

            {children}
        </div>
    );
}
