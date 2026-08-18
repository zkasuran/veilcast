"use client";

import { useState } from "react";
import { num } from "starknet";
import styles from "../../../uni.module.css";
import {
    type BoardFilter,
    DEFAULT_FILTER,
    SORTS,
    applyFilter,
    categoriesOnBoard,
    categoryLabel,
} from "@/utils/discovery";
import type { MarketView } from "@/utils/market";
import BetForm from "./BetForm";
import CommitteeVote from "./CommitteeVote";
import CreateMarket from "./CreateMarket";
import FeedSettle from "./FeedSettle";
import MarketCard from "./MarketCard";
import ResolverControls from "./ResolverControls";
import { useBoard } from "./useBoard";
import { useStrk20 } from "../strk20/useStrk20";

const STATUSES: { key: string; label: string }[] = [
    { key: "open", label: "Taking bets" },
    { key: "closing", label: "Closing soon" },
    { key: "closed", label: "Awaiting resolution" },
    { key: "settled", label: "Settled" },
    { key: "all", label: "Everything" },
];

/// The board: every market, its public volumes, and the bet form for whichever outcome is picked.
export default function MarketsPanel() {
    const strk20 = useStrk20();
    const { markets, error, loading, refresh } = useBoard();
    const [selected, setSelected] = useState<{ marketId: number; outcome: number } | undefined>();
    const [filter, setFilter] = useState<BoardFilter>(DEFAULT_FILTER);

    function isResolver(view: MarketView): boolean {
        if (!strk20.address || view.state !== "Open") return false;
        return sameAddress(view.resolver, strk20.address);
    }

    /// A market whose resolver is the deployed Pragma adapter settles from a feed, so it gets the
    /// feed panel instead of anybody's resolve button.
    function isFeedBound(view: MarketView): boolean {
        return strk20.hasResolver && sameAddress(view.resolver, strk20.resolverAddress);
    }

    /// A market whose resolver is the deployed committee contract is settled by its jury.
    function isCommitteeBound(view: MarketView): boolean {
        return strk20.hasCommittee && sameAddress(view.resolver, strk20.committeeAddress);
    }

    function sameAddress(left: string, right: string): boolean {
        try {
            return num.toBigInt(left) === num.toBigInt(right);
        } catch {
            return false;
        }
    }

    if (!strk20.isStrk20Network) {
        return (
            <div className={styles.panelWide}>
                <div className={styles.notice}>
                    The STRK20 pool lives on Mainnet and Sepolia. Switch your wallet network to see the
                    board.
                </div>
            </div>
        );
    }

    if (!strk20.hasMarket) {
        return (
            <div className={styles.panelWide}>
                <div className={styles.notice}>
                    No Veilcast market is deployed on {strk20.networkName} yet. Deploy
                    <code> cairo/src/market.cairo</code> against the pool, then set
                    <code> NEXT_PUBLIC_VEILCAST_MARKET_{strk20.networkName}</code> in .env.local.
                </div>
            </div>
        );
    }

    const sections = categoriesOnBoard(markets);
    const visible = applyFilter(markets, filter);

    return (
        <div className={styles.panelWide}>
            <div className={styles.boardHead}>
                <input
                    className={styles.searchInput}
                    value={filter.query}
                    onChange={(event) => setFilter({ ...filter, query: event.target.value })}
                    placeholder="Search questions, outcomes, sections, or #id"
                    aria-label="Search the board"
                />
                <button className={styles.btn} onClick={() => void refresh()} disabled={loading}>
                    {loading ? "Reading chain…" : "Refresh"}
                </button>
                <CreateMarket onCreated={refresh} />
            </div>

            {sections.length > 1 ? (
                <div className={styles.chips}>
                    <button
                        className={`${styles.chip} ${filter.category === "all" ? styles.chipActive : ""}`}
                        onClick={() => setFilter({ ...filter, category: "all" })}
                    >
                        All sections
                    </button>
                    {sections.map((section) => (
                        <button
                            key={section}
                            className={`${styles.chip} ${filter.category === section ? styles.chipActive : ""}`}
                            onClick={() => setFilter({ ...filter, category: section })}
                        >
                            {categoryLabel(section)}
                        </button>
                    ))}
                </div>
            ) : null}

            <div className={styles.boardControls}>
                <span className={styles.boardCount}>
                    {visible.length === markets.length
                        ? `${markets.length} markets`
                        : `${visible.length} of ${markets.length} markets`}
                </span>
                <select
                    className={styles.selectInput}
                    value={filter.status}
                    onChange={(event) => setFilter({ ...filter, status: event.target.value })}
                    aria-label="Filter by status"
                >
                    {STATUSES.map((status) => (
                        <option key={status.key} value={status.key}>
                            {status.label}
                        </option>
                    ))}
                </select>
                <select
                    className={styles.selectInput}
                    value={filter.sort}
                    onChange={(event) =>
                        setFilter({ ...filter, sort: event.target.value as BoardFilter["sort"] })
                    }
                    aria-label="Sort the board"
                >
                    {SORTS.map((sort) => (
                        <option key={sort.key} value={sort.key}>
                            {sort.label}
                        </option>
                    ))}
                </select>
            </div>

            {error ? <div className={styles.warn}>Could not read the board: {error}</div> : null}

            {markets.length === 0 && !loading && !error ? (
                <div className={styles.notice}>
                    Nothing is trading yet. Open the first market: anyone can, and whoever does resolves
                    it.
                </div>
            ) : null}

            {markets.length > 0 && visible.length === 0 ? (
                <div className={styles.notice}>
                    No market matches that. Clear the search or switch to Everything.
                </div>
            ) : null}

            {visible.map((view) => (
                <MarketCard
                    key={view.id}
                    view={view}
                    providerIndex={strk20.providerIndex}
                    marketAddress={strk20.marketAddress}
                    detailHref={`/market/?id=${view.id}`}
                    selectedOutcome={selected?.marketId === view.id ? selected.outcome : undefined}
                    onSelectOutcome={(outcome) =>
                        setSelected(outcome === undefined ? undefined : { marketId: view.id, outcome })
                    }
                >
                    {selected?.marketId === view.id ? (
                        <BetForm
                            view={view}
                            outcome={selected.outcome}
                            onPlaced={() => {
                                setSelected(undefined);
                                void refresh();
                            }}
                        />
                    ) : null}
                    {isResolver(view) ? <ResolverControls view={view} onSettled={refresh} /> : null}
                    {isFeedBound(view) && view.state === "Open" ? (
                        <FeedSettle view={view} onSettled={refresh} />
                    ) : null}
                    {isCommitteeBound(view) ? <CommitteeVote view={view} onSettled={refresh} /> : null}
                </MarketCard>
            ))}
        </div>
    );
}
