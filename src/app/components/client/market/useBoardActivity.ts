"use client";

import { useCallback, useEffect, useState } from "react";
import { type MarketEvent, loadBoardActivity } from "@/utils/events";
import { errorMessage, useStrk20 } from "../strk20/useStrk20";

/// The whole board's event stream, newest first. Pass `refreshToken` as the board's last poll time so
/// a live board and the feed refresh together without duplicating timers.
export function useBoardActivity(refreshToken = 0, limit = 50) {
    const strk20 = useStrk20();
    const { provider, marketAddress, hasMarket } = strk20;
    const [events, setEvents] = useState<MarketEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const reload = useCallback(async () => {
        if (!hasMarket) {
            setEvents([]);
            return;
        }
        setLoading(true);
        try {
            const all = await loadBoardActivity(provider, marketAddress);
            setEvents(all.slice(0, limit));
            setError("");
        } catch (failure) {
            setError(errorMessage(failure));
        } finally {
            setLoading(false);
        }
    }, [provider, marketAddress, hasMarket, limit]);

    useEffect(() => {
        void reload();
    }, [reload, refreshToken]);

    return { events, loading, error, reload };
}
