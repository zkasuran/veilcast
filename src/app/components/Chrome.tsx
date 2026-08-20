"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import styles from "../uni.module.css";
import SelectWallet from "./client/WalletHandle/SelectWallet";
import { StrkCoin, BtcCoin, EthCoin, UsdcCoin, ZecCoin } from "./TokenIcons";

// Files in public/ are not rewritten by basePath, so a project page has to prefix them by hand.
const ASSETS = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Scattered, blurred token coins on the sides of the page (background ambience).
type BgToken = {
    Coin: (props: { size?: number }) => React.ReactElement;
    pos: CSSProperties;
    size: number;
    blur: number;
    opacity: number;
};

const BG_TOKENS: BgToken[] = [
    // Left edge
    { Coin: StrkCoin, pos: { top: "30%", left: "3%" }, size: 116, blur: 5, opacity: 0.55 },
    { Coin: BtcCoin, pos: { top: "38%", left: "18%" }, size: 92, blur: 4, opacity: 0.5 },
    { Coin: ZecCoin, pos: { top: "64%", left: "9%" }, size: 140, blur: 6, opacity: 0.5 },
    { Coin: EthCoin, pos: { top: "11%", left: "22%" }, size: 84, blur: 4, opacity: 0.5 },
    { Coin: UsdcCoin, pos: { top: "86%", left: "20%" }, size: 104, blur: 5, opacity: 0.5 },
    // Right edge
    { Coin: EthCoin, pos: { top: "7%", right: "18%" }, size: 128, blur: 5, opacity: 0.55 },
    { Coin: BtcCoin, pos: { top: "12%", right: "4%" }, size: 96, blur: 4, opacity: 0.5 },
    { Coin: StrkCoin, pos: { top: "54%", right: "6%" }, size: 132, blur: 6, opacity: 0.55 },
    { Coin: UsdcCoin, pos: { top: "76%", right: "9%" }, size: 104, blur: 5, opacity: 0.5 },
    { Coin: ZecCoin, pos: { top: "88%", right: "20%" }, size: 100, blur: 5, opacity: 0.48 },
];

export function Aurora() {
    return (
        <div className={styles.aurora} aria-hidden>
            {BG_TOKENS.map((token, index) => (
                <span
                    key={index}
                    className={styles.tok}
                    style={{ ...token.pos, filter: `blur(${token.blur}px)`, opacity: token.opacity }}
                >
                    <token.Coin size={token.size} />
                </span>
            ))}
        </div>
    );
}

export function SiteNav() {
    return (
        <nav className={styles.nav}>
            <Link className={styles.brand} href="/">
                Veilcast
                <span className={styles.brandBadge}>
                    on
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${ASSETS}/tokens/strk20.png`} alt="STRK20" className={styles.brandImg} />
                </span>
            </Link>
            <SelectWallet variant="nav" />
        </nav>
    );
}

export function SiteFooter() {
    return (
        <footer className={styles.footer}>
            <a href="https://github.com/zkasuran/veilcast" target="_blank" rel="noreferrer">
                Repo
            </a>
            <span className={styles.footerDot}>·</span>
            <a href="https://strk20.starknet.io" target="_blank" rel="noreferrer">
                STRK20
            </a>
            <span className={styles.footerDot}>·</span>
            <button
                className={styles.footerLink}
                onClick={() => window.dispatchEvent(new Event("veilcast:show-intro"))}
            >
                How it works
            </button>
            <span className={styles.footerDot}>·</span>
            <span>Bets are anonymous, amounts are not. Read the README before you trust that.</span>
        </footer>
    );
}
