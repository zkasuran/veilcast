"use client";

import { ec } from "starknet";
import { type Coupon, importCoupons, loadCoupons, saveCoupon } from "./veilcast";

/// Passphrase-locked backup for coupons, and a compact bearer form for a single one.
///
/// A coupon is the only thing that can collect its payout, so moving one between devices or handing
/// it to someone means moving its private key. Two ways out of this browser:
///
/// - an **encrypted backup** of every coupon, locked with a passphrase, safe to email to yourself or
///   drop in a password manager. It is AES-GCM with a PBKDF2-stretched key, done in the browser with
///   WebCrypto, so the passphrase never leaves the page and the file is useless without it.
/// - a **bearer ticket** for one coupon: a short string (or the QR of it) that another browser
///   imports to take the position. Whoever holds the ticket holds the payout, which is the point and
///   the risk, so a ticket can be passphrase-locked too.
///
/// Nothing here talks to the chain. It only moves the secret that the chain already treats as the
/// bearer of the position.

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/// The envelope a passphrase-locked payload serializes to. Versioned so a future format can be told
/// apart, and self-describing so decrypt needs only the passphrase.
export type SealedEnvelope = {
    v: 1;
    kind: "vault" | "ticket";
    kdf: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
    iv: string;
    ct: string;
};

/// A single coupon reduced to what a bearer needs. The public key is derivable from the private key,
/// so it is left out and recomputed on import, which halves the ticket and removes a way to ship an
/// inconsistent pair.
export type CouponTicket = {
    v: 1;
    marketId: number;
    outcome: number;
    privateKey: string;
    amount: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/// A byte view as the crypto API wants it. TypeScript's lib narrowed `Uint8Array` to a generic over
/// its backing buffer, so a plain `Uint8Array` no longer satisfies `BufferSource` without this.
function buf(bytes: Uint8Array): BufferSource {
    return bytes as unknown as BufferSource;
}

/// Locks any string behind a passphrase. `kind` is carried in the clear so a reader can tell a whole
/// vault from a single ticket before it has the passphrase.
export async function seal(
    plaintext: string,
    passphrase: string,
    kind: SealedEnvelope["kind"]
): Promise<SealedEnvelope> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: buf(iv) },
        key,
        buf(encoder.encode(plaintext))
    );
    return {
        v: 1,
        kind,
        kdf: "PBKDF2-SHA256",
        iterations: PBKDF2_ITERATIONS,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ct: toBase64(new Uint8Array(ct)),
    };
}

/// Opens a sealed envelope. Throws `WRONG_PASSPHRASE` on a bad passphrase or tampered payload,
/// because AES-GCM authentication fails the same way for both, and there is nothing to gain from
/// telling them apart.
export async function unseal(envelope: SealedEnvelope, passphrase: string): Promise<string> {
    const key = await deriveKey(passphrase, fromBase64(envelope.salt), envelope.iterations);
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: buf(fromBase64(envelope.iv)) },
            key,
            buf(fromBase64(envelope.ct))
        );
        return decoder.decode(plaintext);
    } catch {
        throw new Error("WRONG_PASSPHRASE");
    }
}

/// True for anything that is shaped like an envelope this module wrote, so a reader can branch on
/// encrypted vs plain before it asks for a passphrase.
export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
    const envelope = value as SealedEnvelope | undefined;
    return (
        envelope?.v === 1 &&
        (envelope.kind === "vault" || envelope.kind === "ticket") &&
        typeof envelope.salt === "string" &&
        typeof envelope.iv === "string" &&
        typeof envelope.ct === "string"
    );
}

/// A single coupon as a bearer ticket string: the JSON envelope, base64url so it survives a URL, a
/// text box or a QR without escaping.
export function encodeTicket(coupon: Coupon): string {
    const ticket: CouponTicket = {
        v: 1,
        marketId: coupon.marketId,
        outcome: coupon.outcome,
        privateKey: coupon.privateKey,
        amount: coupon.amount,
    };
    return `veilcast:${base64UrlEncode(JSON.stringify(ticket))}`;
}

/// Reads a bearer ticket back, or null for anything that is not one. The public key and the
/// timestamp are recomputed rather than trusted, so a ticket cannot carry a key that does not match
/// its private half.
export function decodeTicket(text: string, deriveKey: (privateKey: string) => string): Coupon | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("veilcast:")) return null;
    let ticket: CouponTicket;
    try {
        ticket = JSON.parse(base64UrlDecode(trimmed.slice("veilcast:".length)));
    } catch {
        return null;
    }
    if (
        ticket?.v !== 1 ||
        typeof ticket.privateKey !== "string" ||
        typeof ticket.amount !== "string" ||
        typeof ticket.marketId !== "number" ||
        typeof ticket.outcome !== "number"
    ) {
        return null;
    }
    return {
        marketId: ticket.marketId,
        outcome: ticket.outcome,
        privateKey: ticket.privateKey,
        positionKey: deriveKey(ticket.privateKey),
        amount: ticket.amount,
        createdAt: Date.now(),
    };
}

async function deriveKey(
    passphrase: string,
    salt: Uint8Array,
    iterations = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        "raw",
        buf(encoder.encode(passphrase)),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: buf(salt), iterations, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(text: string): string {
    return toBase64(encoder.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): string {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    return decoder.decode(fromBase64(padded));
}

/// What a piece of pasted or uploaded text turned out to be, once read in. `added` is how many
/// coupons it brought into this browser that were not already here.
export type RestoreResult = { source: "vault" | "ticket" | "plain"; added: number; total: number };

/// Takes in whatever the user pasted or uploaded and merges it: a plain backup, an encrypted vault,
/// or a single bearer ticket. `passphrase` is only consulted for an encrypted vault. Returns null
/// for anything unrecognisable, and throws `WRONG_PASSPHRASE` when an encrypted vault will not open.
export async function restoreAny(text: string, passphrase: string): Promise<RestoreResult | null> {
    const trimmed = text.trim();

    // A bearer ticket: one coupon, saved straight in.
    const ticket = decodeTicket(trimmed, (privateKey) => ec.starkCurve.getStarkKey(privateKey));
    if (ticket) {
        const known = new Set(loadCoupons().map((coupon) => coupon.positionKey));
        const merged = saveCoupon(ticket);
        return { source: "ticket", added: known.has(ticket.positionKey) ? 0 : 1, total: merged.length };
    }

    // Anything JSON: either an encrypted envelope or a plain backup.
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (isSealedEnvelope(parsed)) {
        const opened = await unseal(parsed, passphrase);
        // A vault holds a backup; a locked single ticket holds a ticket string.
        const inner = await restoreAny(opened, "");
        return inner ? { ...inner, source: "vault" } : null;
    }
    const merged = importCoupons(trimmed);
    return merged ? { source: "plain", ...merged } : null;
}
