"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { MarketView } from "@/utils/market";
import { useLiveBoard } from "./useLiveBoard";

type BoardState = {
    markets: MarketView[];
    loading: boolean;
    error: string;
    refresh: () => Promise<void>;
    polling: boolean;
    lastUpdated: number;
};

const BoardContext = createContext<BoardState | undefined>(undefined);

/// Gives every panel the same polling board, so a dashboard, the board and the positions all agree
/// about what the chain said at this moment and no tab burns its own RPC reads.
export function BoardProvider({
    children,
    intervalMs = 15_000,
}: {
    children: ReactNode;
    intervalMs?: number;
}) {
    const board = useLiveBoard(24, { intervalMs });

    return (
        <BoardContext.Provider
            value={{
                markets: board.markets,
                loading: board.loading,
                error: board.error,
                refresh: board.refresh,
                polling: board.polling,
                lastUpdated: board.lastUpdated,
            }}
        >
            {children}
        </BoardContext.Provider>
    );
}

export function useBoardContext(): BoardState {
    const state = useContext(BoardContext);
    if (!state) throw new Error("useBoardContext must be used inside <BoardProvider>");
    return state;
}
