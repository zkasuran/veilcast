"use client";

import { useState } from "react";
import styles from "./uni.module.css";
import { Aurora, SiteFooter, SiteNav } from "./components/Chrome";
import Onboarding from "./components/Onboarding";
import ToastContainer from "./components/Toast";
import MarketsPanel from "./components/client/market/MarketsPanel";
import PositionsPanel from "./components/client/market/PositionsPanel";
import LeveragePanel from "./components/client/leverage/LeveragePanel";
import PoolPanel, { type PoolAction } from "./components/client/strk20/PoolPanel";

// Two market tabs, then leverage, then the pool actions a bet is built on.
type TabKey = "markets" | "positions" | "leverage" | PoolAction;

const TABS: { key: TabKey; label: string }[] = [
  { key: "markets", label: "Markets" },
  { key: "positions", label: "Positions" },
  { key: "leverage", label: "Leverage" },
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
          Delegate execution.
          <br />
          <span className={styles.heroAccent}>Never custody.</span>
        </h1>
        <p className={styles.heroSub}>
          A private prediction market where the volume is public, so the price means something, while the
          bettors are not, so the price stays honest. Trade it with leverage. Or hand an agent a bounded
          mandate to close for you. The contract makes it unable to take your money.
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
        ) : tab === "leverage" ? (
          <LeveragePanel />
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
