"use client";

import { ec, hash, num, shortString, stark } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";

// Serde variant indices of `MarketAction` in cairo/src/interface.cairo. The wallet takes raw
// felts, so the calldata layout is written out here by hand and has to match the Cairo enum.
const ACTION_BET = "0x0";
const ACTION_CLAIM = "0x1";
// Serde variant indices of `PayoutTarget`.
const TARGET_OPEN_NOTE = "0x0";
const TARGET_ADDRESS = "0x1";
// Matches CLAIM_MESSAGE_TAG in cairo/src/market.cairo.
const CLAIM_MESSAGE_TAG = shortString.encodeShortString("VEILCAST_CLAIM");

/// The wallet replaces this with the id of the first open note in the same transaction.
export const FIRST_OPEN_NOTE = "${openNoteIds[0]}";

/// Most outcomes a market can carry, matching MAX_OUTCOMES in cairo/src/market.cairo.
export const MAX_OUTCOMES = 8;

const STRK_UNIT = 10n ** 18n;

/// A bet's proof of ownership, kept in the browser and nowhere else.
///
/// The private key is generated per bet, so two bets by the same person share no key and cannot be
/// linked to each other on-chain. Losing the coupon means losing the payout: nothing else in the
/// system knows who owns a position.
export type Coupon = {
    marketId: number;
    outcome: number;
    /// Stark private key. Never leaves this browser.
    privateKey: string;
    /// Stark public key, the position's on-chain owner.
    positionKey: string;
    /// Staked amount in the token's smallest unit, as a decimal string.
    amount: string;
    createdAt: number;
    /// Transaction that placed this bet, once the wallet has accepted it.
    betTx?: string;
    /// Transaction that collected this position, once it has been claimed.
    claimedTx?: string;
};

const COUPON_STORAGE_KEY = "veilcast.coupons.v1";

export function newCoupon(marketId: number, outcome: number, amount: bigint): Coupon {
    const privateKey = stark.randomAddress();
    return {
        marketId,
        outcome,
        privateKey,
        positionKey: ec.starkCurve.getStarkKey(privateKey),
        amount: amount.toString(),
        createdAt: Date.now(),
    };
}
export function loadCoupons(): Coupon[] {
    if (typeof window === "undefined") return [];
    try {
        const stored: unknown = JSON.parse(window.localStorage.getItem(COUPON_STORAGE_KEY) ?? "[]");
        return Array.isArray(stored) ? (stored as Coupon[]) : [];
    } catch {
        // A corrupt store must not take the app down; the coupons are gone either way.
        return [];
    }
}

export function saveCoupon(coupon: Coupon): Coupon[] {
    const coupons = [...loadCoupons(), coupon];
    writeCoupons(coupons);
    return coupons;
}

export function markCouponPlaced(positionKey: string, betTx: string): Coupon[] {
    return patchCoupon(positionKey, { betTx });
}

export function markCouponClaimed(positionKey: string, claimedTx: string): Coupon[] {
    return patchCoupon(positionKey, { claimedTx });
}

function patchCoupon(positionKey: string, patch: Partial<Coupon>): Coupon[] {
    const coupons = loadCoupons().map((coupon) =>
        coupon.positionKey === positionKey ? { ...coupon, ...patch } : coupon
    );
    writeCoupons(coupons);
    return coupons;
}

function writeCoupons(coupons: Coupon[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COUPON_STORAGE_KEY, JSON.stringify(coupons));
}

/// The message a coupon signs to release its payout, matching `claim_message_hash` in
/// cairo/src/market.cairo. `target` is zero for a payout into an open note, or the recipient
/// address for a payout bound to one address.
export function claimMessageHash(
    marketAddress: string,
    marketId: number,
    outcome: number,
    positionKey: string,
    target: string
): string {
    return hash.computePoseidonHashOnElements([
        CLAIM_MESSAGE_TAG,
        marketAddress,
        marketId,
        outcome,
        positionKey,
        target,
    ]);
}
/// Calldata for a bet: `[0, market_id, outcome, amount, position_key]`.
export function betCalldata(coupon: Coupon): string[] {
    return [
        ACTION_BET,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        num.toHex(BigInt(coupon.amount)),
        coupon.positionKey,
    ];
}

/// Calldata for a claim paid into the open note created in the same transaction:
/// `[1, market_id, outcome, position_key, r, s, 0, note_id]`.
///
/// The wallet assigns the note id while it assembles the transaction, so the signature cannot
/// name it. Signing a zero target is therefore a bearer authorization, good for whichever open
/// note this transaction carries and nothing else afterwards, because the position is spent the
/// moment the claim lands.
///
/// `noteIndex` is which open note in the transaction this claim fills, `0` for a lone claim. A batch
/// creates one open note per claim, so claim `i` fills `${openNoteIds[i]}`.
export function claimIntoNoteCalldata(
    coupon: Coupon,
    marketAddress: string,
    noteIndex = 0
): string[] {
    const signature = signClaim(coupon, marketAddress, "0x0");
    return [
        ACTION_CLAIM,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        coupon.positionKey,
        signature.r,
        signature.s,
        TARGET_OPEN_NOTE,
        openNotePlaceholder(noteIndex),
    ];
}

/// The wallet placeholder for the `n`th open note a transaction creates.
export function openNotePlaceholder(index: number): string {
    return index === 0 ? FIRST_OPEN_NOTE : `\${openNoteIds[${index}]}`;
}

/// Calldata for a claim paid to `recipient`: `[1, market_id, outcome, position_key, r, s, 1,
/// recipient]`. The signature covers the recipient, so a copy of this calldata can only ever pay
/// the same address.
export function claimToAddressCalldata(
    coupon: Coupon,
    marketAddress: string,
    recipient: string
): string[] {
    const signature = signClaim(coupon, marketAddress, recipient);
    return [
        ACTION_CLAIM,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        coupon.positionKey,
        signature.r,
        signature.s,
        TARGET_ADDRESS,
        num.toHex(recipient),
    ];
}

function signClaim(coupon: Coupon, marketAddress: string, target: string) {
    const messageHash = claimMessageHash(
        marketAddress,
        coupon.marketId,
        coupon.outcome,
        coupon.positionKey,
        target
    );
    const signature = ec.starkCurve.sign(messageHash, coupon.privateKey);
    return { r: num.toHex(signature.r), s: num.toHex(signature.s) };
}
/// The pool transaction that places a bet: it withdraws the stake into the market, then invokes the
/// market to book it. Both actions settle atomically, and the address the chain records as the
/// sender is the pool, never the bettor.
export function betActions(
    token: string,
    marketAddress: string,
    coupon: Coupon
): WALLET_API.STRK20_ACTION[] {
    return [
        {
            type: "withdraw",
            token,
            amount: num.toHex(BigInt(coupon.amount)),
            recipient: marketAddress,
        },
        { type: "invoke", contract: marketAddress, calldata: betCalldata(coupon) },
    ];
}

/// The pool transaction that collects several payouts at once, each into its own private note.
///
/// It is a run of open-note transfers, one per coupon, then a run of claim invokes, one per coupon,
/// each filling the note at its own index. The order matters twice over: every open note has to be
/// created before the invoke that fills it, and each claim's `${openNoteIds[i]}` has to line up with
/// the `i`th transfer. Collecting a whole settled board is then one signature and one pool proof
/// rather than one per position.
export function batchClaimIntoNotesActions(
    token: string,
    marketAddress: string,
    coupons: Coupon[],
    noteRecipient: string
): WALLET_API.STRK20_ACTION[] {
    const opens: WALLET_API.STRK20_ACTION[] = coupons.map(() => ({
        type: "transfer",
        token,
        amount: "OPEN",
        recipient: noteRecipient,
    }));
    const claims: WALLET_API.STRK20_ACTION[] = coupons.map((coupon, index) => ({
        type: "invoke",
        contract: marketAddress,
        calldata: claimIntoNoteCalldata(coupon, marketAddress, index),
    }));
    return [...opens, ...claims];
}

/// The pool transaction that collects a payout as a private note: it creates an open note, then
/// invokes the market to fill it.
///
/// The order is load-bearing. The pool counts the open notes a transaction creates and rejects one
/// that leaves any of them undeposited, and it applies an invoke's deposits the moment it reaches
/// that action, so a note created after the invoke could never be filled by it.
export function claimIntoNoteActions(
    token: string,
    marketAddress: string,
    coupon: Coupon,
    noteRecipient: string
): WALLET_API.STRK20_ACTION[] {
    return batchClaimIntoNotesActions(token, marketAddress, [coupon], noteRecipient);
}

/// The pool transaction that collects a payout straight to a public address. The payout leaves the
/// pool, so this trades the payout's privacy for a balance the recipient can spend anywhere. The
/// coupon signature names the recipient, so nobody can point this at another address.
export function claimToWalletActions(
    marketAddress: string,
    coupon: Coupon,
    recipient: string
): WALLET_API.STRK20_ACTION[] {
    return [
        {
            type: "invoke",
            contract: marketAddress,
            calldata: claimToAddressCalldata(coupon, marketAddress, recipient),
        },
    ];
}

/// Formats an amount in the token's smallest unit as a STRK string, trimmed to
/// `maxFractionDigits` and with trailing zeros dropped ("4.5", "0.0001", "12").
export function formatStrk(amount: bigint, maxFractionDigits = 4): string {
    const whole = amount / STRK_UNIT;
    const fraction = (amount % STRK_UNIT)
        .toString()
        .padStart(18, "0")
        .slice(0, maxFractionDigits)
        .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/// Parses a STRK amount typed by a user into the token's smallest unit. Returns null for anything
/// that is not a positive number, so a caller never has to trust the input.
export function parseStrk(input: string): bigint | null {
    const trimmed = input.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
    const [whole, fraction = ""] = trimmed.split(".");
    if (fraction.length > 18) return null;
    const amount = BigInt(whole === "" ? "0" : whole) * STRK_UNIT
        + BigInt(fraction.padEnd(18, "0") === "" ? "0" : fraction.padEnd(18, "0"));
    return amount > 0n ? amount : null;
}

/// The share of the pot sitting on one outcome, which is the market's implied probability for it.
/// An empty book has no opinion, so every outcome reads as an even split.
export function impliedProbability(outcomeVolume: bigint, pot: bigint, nOutcomes: number): number {
    if (pot === 0n) return nOutcomes > 0 ? 1 / nOutcomes : 0;
    return Number((outcomeVolume * 10_000n) / pot) / 10_000;
}

/// What a fresh `stake` on an outcome would return if that outcome won, as a multiple of the
/// stake. Mirrors `quote_payout` on an open market: the stake counts itself into both the pot and
/// the winning side, and the market's fee comes off the pot, so the number a bettor sees is the one
/// the contract would pay.
export function payoutMultiple(
    outcomeVolume: bigint,
    pot: bigint,
    stake: bigint,
    feeBps = 0
): number {
    if (stake <= 0n) return 0;
    const winningVolume = outcomeVolume + stake;
    if (winningVolume === 0n) return 0;
    const gross = pot + stake;
    const net = gross - (gross * BigInt(Math.max(0, feeBps))) / 10_000n;
    const payout = (stake * net) / winningVolume;
    return Number((payout * 10_000n) / stake) / 10_000;
}

/// Every coupon in this browser as a JSON backup. A coupon is the only thing that can collect its
/// position, so a user who clears site data without a copy of this has thrown the payout away.
export function couponsBackup(): string {
    return JSON.stringify({ version: 1, coupons: loadCoupons() }, null, 2);
}

/// Merges a backup back in, keyed on the position key so restoring twice is harmless. Returns how
/// many were new, or null if the text is not a backup this app wrote.
export function importCoupons(backup: string): { added: number; total: number } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(backup);
    } catch {
        return null;
    }
    const incoming = (parsed as { coupons?: unknown })?.coupons;
    if (!Array.isArray(incoming)) return null;
    const restored = incoming.filter(isCoupon);
    if (restored.length !== incoming.length) return null;
    const merged = loadCoupons();
    const known = new Set(merged.map((coupon) => coupon.positionKey));
    let added = 0;
    for (const coupon of restored) {
        if (known.has(coupon.positionKey)) continue;
        known.add(coupon.positionKey);
        merged.push(coupon);
        added += 1;
    }
    writeCoupons(merged);
    return { added, total: merged.length };
}

function isCoupon(value: unknown): value is Coupon {
    const coupon = value as Coupon | undefined;
    return (
        typeof coupon?.privateKey === "string" &&
        typeof coupon.positionKey === "string" &&
        typeof coupon.amount === "string" &&
        typeof coupon.marketId === "number" &&
        typeof coupon.outcome === "number"
    );
}

/// How long a market has left, as "4d 2h", "2h 15m", "9m" or "closed". Coarse on purpose: a
/// second-by-second countdown would imply the close is enforced to the second, and it is a block
/// timestamp.
export function formatTimeLeft(closeAt: number, now = Math.floor(Date.now() / 1000)): string {
    const left = closeAt - now;
    if (left <= 0) return "closed";
    const days = Math.floor(left / 86400);
    const hours = Math.floor((left % 86400) / 3600);
    const minutes = Math.floor((left % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
}


