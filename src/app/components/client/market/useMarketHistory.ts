"use client";

import { useCallback, useEffect, useState } from "react";
import { type MarketEvent, type OddsPoint, loadMarketEvents, oddsSeries } from "@/utils/events";
import { errorMessage, useStrk20 } from "../strk20/useStrk20";

/// A market's own history, read from its events: what happened, and where the odds stood after each
/// bet. One filtered query per market, so this costs the same on a busy board as on an empty one.
export function useMarketHistory(marketId: number | undefined, nOutcomes: number) {
    const { provider, marketAddress, hasMarket } = useStrk20();
    const [events, setEvents] = useState<MarketEvent[]>([]);
    const [points, setPoints] = useState<OddsPoint[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const reload = useCallback(async () => {
        if (!hasMarket || marketId === undefined) {
            setEvents([]);
            setPoints([]);
            return;
        }
        setLoading(true);
        try {
            const history = await loadMarketEvents(provider, marketAddress, marketId);
            setEvents(history);
            setPoints(oddsSeries(history, nOutcomes));
            setError("");
        } catch (failure) {
            setError(errorMessage(failure));
        } finally {
            setLoading(false);
        }
    }, [provider, marketAddress, hasMarket, marketId, nOutcomes]);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { events, points, loading, error, reload };
}
