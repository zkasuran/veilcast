"use client";

import { useState } from "react";
import { num } from "starknet";
import styles from "../../../uni.module.css";
import type { MarketView } from "@/utils/market";
import BetForm from "./BetForm";
import CreateMarket from "./CreateMarket";
import FeedSettle from "./FeedSettle";
import MarketCard from "./MarketCard";
import ResolverControls from "./ResolverControls";
import { useBoard } from "./useBoard";
import { useStrk20 } from "../strk20/useStrk20";

/// The board: every market, its public volumes and the bet form for whichever outcome is picked.
export default function MarketsPanel() {
    const strk20 = useStrk20();
    const { markets, error, loading, refresh } = useBoard();
    const [selected, setSelected] = useState<{ marketId: number; outcome: number } | undefined>();

    function isResolver(view: MarketView): boolean {
        if (!strk20.address || view.state !== "Open") return false;
        return sameAddress(view.resolver, strk20.address);
    }

    /// A market whose resolver is the deployed Pragma adapter settles from a feed, so it gets the
    /// feed panel instead of anybody's resolve button.
    function isFeedBound(view: MarketView): boolean {
        return strk20.hasResolver && sameAddress(view.resolver, strk20.resolverAddress);
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

    return (
        <div className={styles.panelWide}>
            <div className={styles.boardHead}>
                <span className={styles.boardCount}>
                    {markets.length === 0 ? "No markets yet" : `${markets.length} markets`}
                </span>
                <button className={styles.btn} onClick={() => void refresh()} disabled={loading}>
                    {loading ? "Reading chain…" : "Refresh"}
                </button>
                <CreateMarket onCreated={refresh} />
            </div>

            {error ? <div className={styles.warn}>Could not read the board: {error}</div> : null}

            {markets.length === 0 && !loading && !error ? (
                <div className={styles.notice}>
                    Nothing is trading yet. Open the first market: anyone can, and whoever does resolves
                    it.
                </div>
            ) : null}

            {markets.map((view) => (
                <MarketCard
                    key={view.id}
                    view={view}
                    providerIndex={strk20.providerIndex}
                    marketAddress={strk20.marketAddress}
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
                </MarketCard>
            ))}
        </div>
    );
}
