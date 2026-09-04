"use client";

import { useCallback, useEffect, useState } from "react";
import { type MarketView, loadBoard } from "@/utils/market";
import { errorMessage, useStrk20 } from "../strk20/useStrk20";

/// The board, read from the market contract on the current network. One place does the reading so
/// the markets tab and the positions tab agree about what a market says.
export function useBoard(limit = 24) {
    const strk20 = useStrk20();
    const { provider, marketAddress, hasMarket } = strk20;
    const [markets, setMarkets] = useState<MarketView[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        if (!hasMarket) {
            setMarkets([]);
            return;
        }
        setLoading(true);
        try {
            setMarkets(await loadBoard(provider, marketAddress, limit));
            setError("");
        } catch (failure) {
            setError(errorMessage(failure));
        } finally {
            setLoading(false);
        }
    }, [provider, marketAddress, hasMarket, limit]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return { markets, error, loading, refresh };
}
