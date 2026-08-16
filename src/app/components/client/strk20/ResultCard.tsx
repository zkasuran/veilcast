"use client";

import styles from "../../../uni.module.css";
import { voyagerTxUrl } from "@/utils/constants";
import type { ActionResult } from "./useStrk20";

/// The readable result of one action: a title, a row per fact, an explorer link for any hash.
export default function ResultCard({
    result,
    providerIndex,
}: {
    result: ActionResult;
    providerIndex: number;
}) {
    const tone =
        result.status === "error"
            ? styles.receiptError
            : result.status === "pending"
            ? styles.receiptPending
            : styles.receiptOk;
    return (
        <div className={`${styles.receipt} ${tone}`}>
            <div className={styles.receiptHead}>
                <span className={styles.receiptIcon}>
                    {result.status === "ok" ? "✓" : result.status === "error" ? "!" : "⋯"}
                </span>
                <span>{result.title}</span>
            </div>
            {result.rows?.length ? (
                <div className={styles.receiptRows}>
                    {result.rows.map((row) => (
                        <div key={row.label} className={styles.receiptRow}>
                            <span className={styles.receiptLabel}>{row.label}</span>
                            {row.hash ? (
                                <a
                                    className={styles.receiptLink}
                                    href={voyagerTxUrl(providerIndex, row.hash)}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {row.value} ↗
                                </a>
                            ) : (
                                <span className={styles.receiptValue}>{row.value}</span>
                            )}
                        </div>
                    ))}
                </div>
            ) : null}
            {result.note ? <pre className={styles.receiptNote}>{result.note}</pre> : null}
        </div>
    );
}
