"use client";

import { useCallback, useEffect, useState } from "react";
import { type MarketView, loadBoard } from "@/utils/market";
import { createDemoMarkets, demoEnabled } from "@/utils/demoBoard";
import { errorMessage, useStrk20 } from "../strk20/useStrk20";

/// The board, read from the market contract on the current network. One place does the reading so
/// the markets tab and the positions tab agree about what a market says.
///
/// When the current network has no Veilcast market configured, `demo` becomes true and the board is
/// seeded with clearly-labelled sample markets so the hosted project page and a fresh clone show the
/// full product instead of an empty state. Demo data is client-side only, never written to the
/// chain, and is marked DEMO throughout the UI.
export function useBoard(limit = 24) {
    const strk20 = useStrk20();
    const { provider, marketAddress, hasMarket } = strk20;
    const [markets, setMarkets] = useState<MarketView[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [demo, setDemo] = useState(false);

    const refresh = useCallback(async () => {
        if (!hasMarket) {
            if (demoEnabled()) {
                setMarkets(createDemoMarkets());
                setDemo(true);
                setError("");
            } else {
                setMarkets([]);
                setDemo(false);
            }
            return;
        }
        setDemo(false);
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

    return { markets, error, loading, refresh, demo };
}
