"use client";

import Link from "next/link";
import styles from "../../neon.module.css";
import uni from "../../uni.module.css";
import { useStrk20 } from "./strk20/useStrk20";
import ThemeToggle from "../ThemeToggle";
import SelectWallet from "./WalletHandle/SelectWallet";
import { useBoardContext } from "./market/BoardContext";

/// The persistent shell. It is the first thing a visitor sees, so it carries the network, the live
/// board status and the wallet — everything a head of the site should offer without a scroll.
export default function ShellNav() {
    const strk20 = useStrk20();
    const { loading, error, lastUpdated, polling, markets } = useBoardContext();
    const network = strk20.networkName ?? "network";
    const live = !loading && !error && markets.length > 0 && polling;
    const status = live ? network : error ? `${network} · unreadable` : network;

    return (
        <header className={styles.glassNav}>
            <nav className={uni.nav}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Link href="/" className={uni.brand} aria-label="Veilcast home">
                        <span className={styles.brandMark}>V</span>
                        <span>Veilcast</span>
                        <span className={uni.brandBadge}>private markets · STRK20</span>
                    </Link>
                    <span className={`${styles.liveDot} ${live ? "" : styles.liveDotMuted}`} title={lastUpdated ? `Last read ${formatAge(lastUpdated)}` : "Waiting for first read"}>
                        {"LIVE"}
                    </span>
                </div>
                <div className={uni.navRight}>
                    <span className={styles.navTicker}>
                        {status}
                        {markets.length > 0 ? ` · ${markets.length} markets` : ""}
                    </span>
                    <ThemeToggle />
                    <SelectWallet variant="nav" />
                </div>
            </nav>
        </header>
    );
}

function formatAge(then: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
