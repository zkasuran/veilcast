"use client";

import type { MarketView } from "./market";
import type { MarketEvent } from "./events";

/// A deterministic, clearly-labelled board for previews and screenshots.
///
/// The app is a live dApp: when a real market is deployed it reads the chain and this file is never
/// reached. When nothing is deployed (a fresh clone, GitHub Pages without repo variables set), the
/// UI would otherwise be a wall of empty states, so this module seeds the same `MarketView` shape the
/// contract returns. Everything is client-side, marked DEMO in the UI, and never pretends to be
/// on-chain data.
const STRK = 10n ** 18n;
const DAY = 24 * 3600;

/// Whether the demo board is enabled. Defaults to on so a fresh clone and a hosted project page show
/// the product; anyone can opt out with `veilcast.demoBoard = "off"` in localStorage.
export function demoEnabled(): boolean {
    if (typeof window === "undefined") return true;
    try {
        const stored = window.localStorage.getItem("veilcast.demoBoard");
        if (stored === "off") return false;
    } catch {
        // A browser with storage blocked still gets the demo board; it just cannot persist the toggle.
    }
    return true;
}

export function setDemoEnabled(enabled: boolean): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem("veilcast.demoBoard", enabled ? "on" : "off");
    } catch {
        // The board still works for the current session.
    }
}

export function createDemoMarkets(now = Math.floor(Date.now() / 1000)): MarketView[] {
    const at = (hours: number) => now + Math.floor(hours * 3600);
    const past = (hours: number) => now - Math.floor(hours * 3600);

    return [
        {
            id: 1,
            question: "Will BTC close above $120,000 on Friday?",
            labels: ["Yes", "No"],
            volumes: [78n * STRK, 41n * STRK],
            pot: 119n * STRK,
            closeAt: at(30),
            createdAt: past(26),
            category: "Crypto",
            feeBps: 100,
            feeRecipient: "0x123",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xabc",
        },
        {
            id: 2,
            question: "Will STRK trade above $3 by the next Starknet upgrade?",
            labels: ["Yes", "No", "Not sure"],
            volumes: [22n * STRK, 9n * STRK, 3n * STRK],
            pot: 34n * STRK,
            closeAt: at(72),
            createdAt: past(10),
            category: "Crypto",
            feeBps: 200,
            feeRecipient: "0x124",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xdef",
        },
        {
            id: 3,
            question: "Will team A win the season opener on Saturday?",
            labels: ["Home", "Away"],
            volumes: [12n * STRK, 27n * STRK],
            pot: 39n * STRK,
            closeAt: at(12),
            createdAt: past(52),
            category: "Sports",
            feeBps: 100,
            feeRecipient: "0x125",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xabc",
        },
        {
            id: 4,
            question: "Will the proposal pass the July committee vote?",
            labels: ["Yes", "No"],
            volumes: [16n * STRK, 16n * STRK],
            pot: 32n * STRK,
            closeAt: at(48),
            createdAt: past(30),
            category: "Politics",
            feeBps: 0,
            feeRecipient: "0x0",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xabc",
        },
        {
            id: 5,
            question: "Will the SDK reach 100k downloads this quarter?",
            labels: ["Yes", "No"],
            volumes: [5n * STRK, 2n * STRK],
            pot: 7n * STRK,
            closeAt: at(120),
            createdAt: past(80),
            category: "Tech",
            feeBps: 100,
            feeRecipient: "0x126",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xabc",
        },
        {
            id: 6,
            question: "Closing soon: will the hackathon winner ship before Sunday?",
            labels: ["Yes", "No"],
            volumes: [31n * STRK, 9n * STRK],
            pot: 40n * STRK,
            closeAt: at(3),
            createdAt: past(64),
            category: "Culture",
            feeBps: 100,
            feeRecipient: "0x127",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xabc",
        },
        {
            id: 7,
            question: "Will mainnet gas stay under 0.01 STRK through the month?",
            labels: ["Yes", "No"],
            volumes: [57n * STRK, 60n * STRK],
            pot: 117n * STRK,
            closeAt: at(18),
            createdAt: past(18),
            category: "Tech",
            feeBps: 150,
            feeRecipient: "0x128",
            feeOwed: 0n,
            state: "Open",
            winningOutcome: 0,
            resolver: "0xdef",
        },
        {
            id: 8,
            question: "Will the film win the audience award?",
            labels: ["Yes", "No"],
            volumes: [220n * STRK, 18n * STRK],
            pot: 238n * STRK,
            closeAt: past(12),
            createdAt: past(20 * DAY),
            category: "Culture",
            feeBps: 100,
            feeRecipient: "0x129",
            feeOwed: 3n * STRK,
            state: "Resolved",
            winningOutcome: 0,
            resolver: "0xabc",
        },
        {
            id: 9,
            question: "Will the coin rise 5% before the summit?",
            labels: ["Yes", "No"],
            volumes: [14n * STRK, 7n * STRK],
            pot: 21n * STRK,
            closeAt: past(4),
            createdAt: past(12 * DAY),
            category: "Crypto",
            feeBps: 100,
            feeRecipient: "0x130",
            feeOwed: 0n,
            state: "Void",
            winningOutcome: 0,
            resolver: "0xabc",
        },
    ];
}

/// A small synthetic event stream for the demo board. It uses the same `MarketEvent` shape the chain
/// publishes so the Live feed renders identically, and it never carries an address.
export function createDemoActivity(now = Math.floor(Date.now() / 1000)): MarketEvent[] {
    const base = createDemoMarkets(now);
    const bet = (marketId: number, outcome: number, amount: bigint, outcomeVolume: bigint, blockNumber: number): MarketEvent => ({
        kind: "bet",
        marketId,
        blockNumber,
        txHash: demoHash(blockNumber, marketId, outcome),
        outcome,
        amount,
        outcomeVolume,
        positionKey: demoKey(blockNumber, marketId, outcome),
    });
    return [
        bet(1, 0, 18n * STRK, 78n * STRK, base[0].createdAt + 100),
        bet(1, 1, 9n * STRK, 41n * STRK, base[0].createdAt + 180),
        bet(3, 1, 12n * STRK, 27n * STRK, base[2].createdAt + 90),
        {
            kind: "resolved",
            marketId: 8,
            blockNumber: base[7].createdAt + 700,
            txHash: demoHash(base[7].createdAt + 700, 8, 0),
            outcome: 0,
            amount: 238n * STRK,
        } as MarketEvent,
        bet(2, 0, 6n * STRK, 22n * STRK, base[1].createdAt + 240),
        bet(7, 1, 11n * STRK, 60n * STRK, base[6].createdAt + 120),
        {
            kind: "void",
            marketId: 9,
            blockNumber: base[8].createdAt + 500,
            txHash: demoHash(base[8].createdAt + 500, 9, 0),
        } as MarketEvent,
    ].sort((left, right) => right.blockNumber - left.blockNumber);
}

function demoKey(seed: number, marketId: number, outcome: number): string {
    const n = BigInt(seed * 7919 + marketId * 104729 + outcome * 1299709) % 0x4000000000000000n;
    return `0x${n.toString(16).padStart(12, "0")}`;
}

function demoHash(seed: number, marketId: number, outcome: number): string {
    const n = BigInt(seed * 15485863 + marketId * 32452843 + outcome * 49979687) % 0x8000000000000000000000000000000000000000n;
    return `0x${n.toString(16).padStart(16, "0")}…${(n % 0xFFFFn).toString(16).padStart(4, "0")}`;
}
