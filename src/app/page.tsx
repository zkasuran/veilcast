"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import styles from "./uni.module.css";
import SelectWallet from "./components/client/WalletHandle/SelectWallet";
import MarketsPanel from "./components/client/market/MarketsPanel";
import PositionsPanel from "./components/client/market/PositionsPanel";
import PoolPanel, { type PoolAction } from "./components/client/strk20/PoolPanel";
import { StrkCoin, BtcCoin, EthCoin, UsdcCoin, ZecCoin } from "./components/TokenIcons";

// Scattered, blurred token coins on the sides of the page (background ambience).
type BgToken = {
  Coin: (p: { size?: number }) => React.ReactElement;
  pos: CSSProperties;
  size: number;
  blur: number;
  opacity: number;
};
const BG_TOKENS: BgToken[] = [
  // Left edge
  { Coin: StrkCoin, pos: { top: '30%', left: '3%' }, size: 116, blur: 5, opacity: 0.55 },
  { Coin: BtcCoin, pos: { top: '38%', left: '18%' }, size: 92, blur: 4, opacity: 0.5 },
  { Coin: ZecCoin, pos: { top: '64%', left: '9%' }, size: 140, blur: 6, opacity: 0.5 },
  { Coin: EthCoin, pos: { top: '11%', left: '22%' }, size: 84, blur: 4, opacity: 0.5 },
  { Coin: UsdcCoin, pos: { top: '86%', left: '20%' }, size: 104, blur: 5, opacity: 0.5 },
  // Right edge
  { Coin: EthCoin, pos: { top: '7%', right: '18%' }, size: 128, blur: 5, opacity: 0.55 },
  { Coin: BtcCoin, pos: { top: '12%', right: '4%' }, size: 96, blur: 4, opacity: 0.5 },
  { Coin: StrkCoin, pos: { top: '54%', right: '6%' }, size: 132, blur: 6, opacity: 0.55 },
  { Coin: UsdcCoin, pos: { top: '76%', right: '9%' }, size: 104, blur: 5, opacity: 0.5 },
  { Coin: ZecCoin, pos: { top: '88%', right: '20%' }, size: 100, blur: 5, opacity: 0.48 },
];

// Files in public/ are not rewritten by basePath, so a project page has to prefix them by hand.
const ASSETS = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

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
      <div className={styles.aurora} aria-hidden>
        {BG_TOKENS.map((t, i) => (
          <span
            key={i}
            className={styles.tok}
            style={{ ...t.pos, filter: `blur(${t.blur}px)`, opacity: t.opacity }}
          >
            <t.Coin size={t.size} />
          </span>
        ))}
      </div>

      <nav className={styles.nav}>
        <div className={styles.brand}>
          Veilcast
          <span className={styles.brandBadge}>
            on
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${ASSETS}/tokens/strk20.png`} alt="STRK20" className={styles.brandImg} />
          </span>
        </div>
        <SelectWallet variant="nav" />
      </nav>

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

      <footer className={styles.footer}>
        <a href="https://github.com/zkasuran/veilcast" target="_blank" rel="noreferrer">
          Repo
        </a>
        <span className={styles.footerDot}>·</span>
        <a href="https://strk20.starknet.io" target="_blank" rel="noreferrer">
          STRK20
        </a>
        <span className={styles.footerDot}>·</span>
        <span>Bets are anonymous, amounts are not. Read the README before you trust that.</span>
      </footer>
    </div>
  );
}
