"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import { encodeTicket, seal } from "@/utils/vault";
import type { Coupon } from "@/utils/veilcast";
import QrCode from "./QrCode";

/// Hands one coupon off to another device or another person.
///
/// A coupon is a bearer instrument: whoever holds the key collects the payout. This turns one into a
/// ticket string and its QR, and can lock the ticket behind a passphrase first, for the case where
/// the channel it travels on is not private. Nothing here touches the chain; it moves the secret the
/// chain already treats as the owner.
export default function CouponShare({ coupon, onClose }: { coupon: Coupon; onClose: () => void }) {
    const plain = encodeTicket(coupon);
    const [passphrase, setPassphrase] = useState("");
    const [locked, setLocked] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);

    // The QR carries the plain ticket only. A locked ticket is an envelope of base64, too long to
    // scan reliably, so it goes by copy rather than by camera.
    const shown = locked ?? plain;

    async function lock() {
        if (passphrase.trim() === "") return;
        setBusy(true);
        try {
            setLocked(JSON.stringify(await seal(plain, passphrase, "ticket")));
        } finally {
            setBusy(false);
        }
    }

    async function copy() {
        try {
            await navigator.clipboard.writeText(shown);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // A browser that refuses the clipboard still shows the text to select by hand.
        }
    }

    return (
        <div className={styles.shareBox}>
            <div className={styles.createHead}>
                <span>Move this position</span>
                <button className={styles.modalClose} onClick={onClose} aria-label="Close">
                    ×
                </button>
            </div>

            {locked ? null : (
                <div className={styles.shareQr}>
                    <QrCode text={plain} />
                </div>
            )}

            <textarea className={styles.textArea} value={shown} readOnly rows={locked ? 4 : 3} aria-label="Coupon ticket" />

            <div className={styles.shareActions}>
                <button className={`${styles.btn} ${styles.btnGreen}`} onClick={copy}>
                    {copied ? "Copied" : locked ? "Copy locked ticket" : "Copy ticket"}
                </button>
            </div>

            {locked ? (
                <div className={styles.positionNote}>
                    Locked. Whoever imports it needs the passphrase. The QR is hidden because an
                    encrypted ticket is too long to scan.
                </div>
            ) : (
                <div className={styles.lockRow}>
                    <input
                        className={styles.textInput}
                        type="password"
                        value={passphrase}
                        onChange={(event) => setPassphrase(event.target.value)}
                        placeholder="Optional passphrase to lock it"
                        aria-label="Passphrase to lock the ticket"
                    />
                    <button
                        className={styles.btn}
                        disabled={busy || passphrase.trim() === ""}
                        onClick={lock}
                    >
                        {busy ? "Locking…" : "Lock"}
                    </button>
                </div>
            )}

            <div className={styles.positionNote}>
                Anyone who holds this ticket can collect the payout, and once you hand it over you no
                longer can. Treat it like cash.
            </div>
        </div>
    );
}
