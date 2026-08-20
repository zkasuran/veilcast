"use client";

import { useRef, useState } from "react";
import styles from "../../../uni.module.css";
import { restoreAny, seal } from "@/utils/vault";
import { couponsBackup } from "@/utils/veilcast";
import { errorMessage } from "../strk20/useStrk20";

type Panel = "backup" | "restore" | undefined;

/// The safety-deposit tools for the coupons this browser holds.
///
/// A coupon is the only thing that can collect its payout, so the vault is where those secrets leave
/// and enter safely: a plain backup, a passphrase-locked one, and a single box that takes any of
/// them back plus a bearer ticket handed over by someone else.
export default function VaultTools({ count, onChanged }: { count: number; onChanged: () => void }) {
    const [panel, setPanel] = useState<Panel>();
    const [passphrase, setPassphrase] = useState("");
    const [restoreText, setRestoreText] = useState("");
    const [restorePass, setRestorePass] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    function saveFile(contents: string, suffix: string) {
        const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `veilcast-coupons-${new Date().toISOString().slice(0, 10)}${suffix}.json`;
        link.click();
        URL.revokeObjectURL(url);
    }

    function downloadPlain() {
        saveFile(couponsBackup(), "");
        setNote("Plain backup downloaded. Anyone who opens the file can spend the positions in it.");
    }

    async function downloadEncrypted() {
        if (passphrase.trim() === "") return;
        setBusy(true);
        try {
            const sealed = await seal(couponsBackup(), passphrase, "vault");
            saveFile(JSON.stringify(sealed, null, 2), "-encrypted");
            setNote("Encrypted backup downloaded. It is useless without the passphrase, so do not lose it.");
            setPassphrase("");
        } finally {
            setBusy(false);
        }
    }

    async function runRestore(text: string) {
        if (text.trim() === "") return;
        setBusy(true);
        try {
            const result = await restoreAny(text, restorePass);
            if (!result) {
                setNote("That is not a Veilcast backup or ticket.");
                return;
            }
            const what = result.source === "ticket" ? "ticket" : "backup";
            setNote(`Restored ${result.added} new from the ${what}, ${result.total} in this browser now.`);
            setRestoreText("");
            setRestorePass("");
            onChanged();
        } catch (failure) {
            setNote(
                errorMessage(failure) === "WRONG_PASSPHRASE"
                    ? "Wrong passphrase for that encrypted backup."
                    : `Could not restore: ${errorMessage(failure)}`
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.vaultBox}>
            <div className={styles.vaultTabs}>
                <button
                    className={`${styles.chip} ${panel === "backup" ? styles.chipActive : ""}`}
                    onClick={() => setPanel(panel === "backup" ? undefined : "backup")}
                    disabled={count === 0}
                >
                    Back up
                </button>
                <button
                    className={`${styles.chip} ${panel === "restore" ? styles.chipActive : ""}`}
                    onClick={() => setPanel(panel === "restore" ? undefined : "restore")}
                >
                    Restore or receive
                </button>
            </div>

            {panel === "backup" ? (
                <div className={styles.vaultPanel}>
                    <button className={styles.btn} onClick={downloadPlain}>
                        Download plain backup
                    </button>
                    <div className={styles.lockRow}>
                        <input
                            className={styles.textInput}
                            type="password"
                            value={passphrase}
                            onChange={(event) => setPassphrase(event.target.value)}
                            placeholder="Passphrase"
                            aria-label="Passphrase to encrypt the backup"
                        />
                        <button
                            className={`${styles.btn} ${styles.btnGreen}`}
                            disabled={busy || passphrase.trim() === ""}
                            onClick={downloadEncrypted}
                        >
                            {busy ? "Encrypting…" : "Download encrypted"}
                        </button>
                    </div>
                    <div className={styles.positionNote}>
                        Encrypted with AES-GCM and a passphrase-stretched key, in this browser. The
                        passphrase never leaves the page and the file cannot be opened without it.
                    </div>
                </div>
            ) : null}

            {panel === "restore" ? (
                <div className={styles.vaultPanel}>
                    <textarea
                        className={styles.textArea}
                        value={restoreText}
                        onChange={(event) => setRestoreText(event.target.value)}
                        placeholder="Paste a backup or a veilcast: ticket"
                        aria-label="Backup or ticket to restore"
                        rows={3}
                    />
                    <div className={styles.lockRow}>
                        <input
                            className={styles.textInput}
                            type="password"
                            value={restorePass}
                            onChange={(event) => setRestorePass(event.target.value)}
                            placeholder="Passphrase, if it is encrypted"
                            aria-label="Passphrase for an encrypted backup"
                        />
                        <button
                            className={`${styles.btn} ${styles.btnGreen}`}
                            disabled={busy || restoreText.trim() === ""}
                            onClick={() => void runRestore(restoreText)}
                        >
                            {busy ? "Restoring…" : "Restore"}
                        </button>
                    </div>
                    <button className={styles.btn} onClick={() => fileInput.current?.click()}>
                        Or choose a file
                    </button>
                    <input
                        ref={fileInput}
                        className={styles.hiddenInput}
                        type="file"
                        accept="application/json,.json,.txt"
                        onChange={async (event) => {
                            const file = event.target.files?.[0];
                            if (file) await runRestore(await file.text());
                        }}
                    />
                </div>
            ) : null}

            {note ? <div className={styles.notice}>{note}</div> : null}
        </div>
    );
}
