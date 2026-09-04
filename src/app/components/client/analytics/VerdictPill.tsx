"use client";

import styles from "../../../neon.module.css";
import type { AnalysisVerdict } from "@/utils/analytics";

/// A compact verdict chip. It only ever says what the deterministic on-chain facets concluded, so
/// the colour always has a number behind it.
export default function VerdictPill({ verdict }: { verdict: AnalysisVerdict }) {
    const tone =
        verdict === "Strong YES"
            ? styles.verdictStrongYes
            : verdict === "Strong NO"
            ? styles.verdictStrongNo
            : verdict === "YES"
            ? styles.verdictYes
            : verdict === "NO"
            ? styles.verdictNo
            : styles.verdictNeutral;
    const arrow =
        verdict === "Strong YES" || verdict === "YES"
            ? "▲"
            : verdict === "Strong NO" || verdict === "NO"
            ? "▼"
            : "•";
    return (
        <span className={`${styles.verdict} ${tone}`}>
            {arrow} {verdict}
        </span>
    );
}
