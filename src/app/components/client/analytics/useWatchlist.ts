"use client";

import { useEffect, useState } from "react";

/// A market a visitor is following. Stored per browser (never on-chain, never uploaded) so a
/// visitor can build a shortlist across sessions without changing anything about privacy.
const KEY = "veilcast.watchlist.v1";

export function loadWatchlist(): number[] {
    if (typeof window === "undefined") return [];
    try {
        const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
        return Array.isArray(stored) ? stored.map(Number).filter((id) => Number.isInteger(id)) : [];
    } catch {
        return [];
    }
}

function writeWatchlist(ids: number[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
        // The worst case is a watchlist that forgets itself; nothing else depends on it.
    }
}

export function useWatchlist() {
    const [ids, setIds] = useState<number[]>([]);

    useEffect(() => {
        setIds(loadWatchlist());
    }, []);

    function has(id: number): boolean {
        return ids.includes(id);
    }

    function toggle(id: number): void {
        setIds((current) => {
            const next = current.includes(id)
                ? current.filter((value) => value !== id)
                : [...current, id];
            writeWatchlist(next);
            return next;
        });
    }

    return { ids, has, toggle };
}
