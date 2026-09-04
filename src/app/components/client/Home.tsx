"use client";

import { useState } from "react";
import styles from "../../uni.module.css";
import neon from "../../neon.module.css";
import { Aurora, SiteFooter } from "../Chrome";
import Onboarding from "../Onboarding";
import ToastContainer from "../Toast";
import { BoardProvider } from "./market/BoardContext";
import ShellNav from "./ShellNav";
import Dashboard from "./analytics/Dashboard";
import AnalyticsPanel from "./analytics/AnalyticsPanel";
import WatchlistPanel from "./analytics/WatchlistPanel";
import MarketsPanel from "./market/MarketsPanel";
import PositionsPanel from "./market/PositionsPanel";
import LeveragePanel from "./leverage/LeveragePanel";
import ActivityPanel from "./market/ActivityPanel";
import PoolPanel, { type PoolAction } from "./strk20/PoolPanel";

// Two market tabs, then leverage, then the pool actions a bet is built on. The radar and shortlist
// are the analytics surface on top of the same public board.
type TabKey = "markets" | "positions" | "leverage" | "analytics" | "watchlist" | "activity" | PoolAction;

const TABS: { key: TabKey; label: string }[] = [
    { key: "markets", label: "Markets" },
    { key: "analytics", label: "Radar" },
    { key: "watchlist", label: "Shortlist" },
    { key: "activity", label: "Live feed" },
    { key: "positions", label: "Positions" },
    { key: "leverage", label: "Leverage" },
    { key: "shield", label: "Shield" },
    { key: "send", label: "Send" },
    { key: "unshield", label: "Unshield" },
    { key: "balances", label: "Balances" },
];

export default function Home() {
    const [tab, setTab] = useState<TabKey>("markets");

    return (
        <div className={styles.page}>
            <div className={neon.neonGrid} aria-hidden />
            <Aurora />
            <BoardProvider>
                <ShellNav />

                <Dashboard onExplore={() => setTab("markets")} />
                <LiveTabs tab={tab} setTab={setTab} />

                <main>
                    {tab === "markets" ? (
                        <MarketsPanel />
                    ) : tab === "analytics" ? (
                        <AnalyticsPanel />
                    ) : tab === "watchlist" ? (
                        <WatchlistPanel />
                    ) : tab === "activity" ? (
                        <ActivityPanel />
                    ) : tab === "positions" ? (
                        <PositionsPanel />
                    ) : tab === "leverage" ? (
                        <LeveragePanel />
                    ) : (
                        <PoolPanel action={tab} />
                    )}
                </main>

                <SiteFooter />
            </BoardProvider>
            <Onboarding />
            <ToastContainer />
        </div>
    );
}

function LiveTabs({ tab, setTab }: { tab: TabKey; setTab: (tab: TabKey) => void }) {
    return (
        <nav className={neon.tabs} aria-label="Veilcast sections">
            {TABS.map((item) => (
                <button
                    key={item.key}
                    className={`${neon.tab} ${tab === item.key ? neon.tabActive : ""}`}
                    onClick={() => setTab(item.key)}
                >
                    {item.label}
                </button>
            ))}
        </nav>
    );
}
