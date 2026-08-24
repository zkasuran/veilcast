"use client";

import { useState } from "react";
import styles from "./uni.module.css";
import { Aurora, SiteFooter, SiteNav } from "./components/Chrome";
import Onboarding from "./components/Onboarding";
import ToastContainer from "./components/Toast";
import MarketsPanel from "./components/client/market/MarketsPanel";
import PositionsPanel from "./components/client/market/PositionsPanel";
import PoolPanel, { type PoolAction } from "./components/client/strk20/PoolPanel";

// Two market tabs, then the pool actions a bet is built on.
type TabKey = "markets" | "positions" | PoolAction;

const TABS: { key: TabKey; label: string }[] = [
  { key: "markets", label: "Markets" },
  { key: "positions", label: "Positions" },
  { key: "shield", label: "Shield" },
  { key: "send", label: "Send" },
  { key: "unshield", label: "Unshield" },
  { key: "balances", label: "Balances" },
];

export default function Page() {
  const [tab, setTab] = useState<TabKey>("markets");

  return (
    <div className={styles.page}>
      <Aurora />
      <SiteNav />

      <header className={styles.hero}>
        <h1 className={styles.heroTitle}>
          Visible odds
          <br />
          <span className={styles.heroAccent}>Invisible bettors</span>
        </h1>
        <p className={styles.heroSub}>
          A prediction market where the volume is public, so the price means something, and the
          bettors are not, so the price stays honest. Stakes and payouts move through the STRK20
          privacy pool.
        </p>
      </header>

      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <main>
        {tab === "markets" ? (
          <MarketsPanel />
        ) : tab === "positions" ? (
          <PositionsPanel />
        ) : (
          <PoolPanel action={tab} />
        )}
      </main>

      <SiteFooter />
      <Onboarding />
      <ToastContainer />
    </div>
  );
}
