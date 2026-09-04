"use client";

import { useMemo } from "react";
import { deriveAnalytics, boardAnalytics, type BoardAnalysis, type MarketAnalysis } from "@/utils/analytics";
import { useLiveBoard } from "../market/useLiveBoard";

/// The analytics surface is a pure function of the public board. It never rolls a model, never calls
/// an API and never uploads a byte: the same market the board reads becomes the same set of
/// deterministic on-chain facets every visitor gets. `useLiveBoard` keeps it fresh on a local timer,
/// so the dashboard can show a live board without a server.
export function useMarketAnalytics() {
    const board = useLiveBoard();
    const analytics = useMemo<{ reads: MarketAnalysis[]; meta: BoardAnalysis }>(() => {
        const reads = deriveAnalytics(board.markets);
        return { reads, meta: boardAnalytics(reads) };
    }, [board.markets]);

    return {
        markets: board.markets,
        reads: analytics.reads,
        meta: analytics.meta,
        loading: board.loading,
        error: board.error,
        refresh: board.refresh,
        polling: board.polling,
    };
}
