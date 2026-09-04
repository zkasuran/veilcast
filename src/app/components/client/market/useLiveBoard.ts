"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBoard } from "./useBoard";

/// The board plus a lightweight client-side polling loop. The app is static, so "live" here means a
/// local timer that re-reads the chain — no websocket, no server, nothing to connect that a static
/// host could not provide. `enabled` lets a tab pause polling without unmounting the board.
export function useLiveBoard(
    limit = 24,
    { enabled = true, intervalMs = 15_000 }: { enabled?: boolean; intervalMs?: number } = {}
) {
    const board = useBoard(limit);
    const [lastUpdated, setLastUpdated] = useState(0);
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        await board.refresh();
        setLastUpdated(Date.now());
    }, [board.refresh]);

    useEffect(() => {
        if (!enabled) {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
            return;
        }
        timer.current = setInterval(() => void refresh(), intervalMs);
        return () => {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
        };
    }, [enabled, intervalMs, refresh]);

    return { ...board, refresh, lastUpdated, polling: enabled };
}
