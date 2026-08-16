"use client";

import styles from "../../../uni.module.css";
import { StrkCoin } from "../../TokenIcons";

/// The panel's amount field: a big STRK input with a label above and a hint line below. Shared by
/// the pool actions and the bet form so a bet looks like every other amount in the app.
export default function AmountInput({
    label,
    value,
    onChange,
    hint,
    detail,
    disabled,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    hint: string;
    detail?: string;
    disabled?: boolean;
}) {
    return (
        <div className={styles.inputBlock}>
            <div className={styles.inputLabel}>{label}</div>
            <div className={styles.inputMain}>
                <input
                    className={styles.bigInput}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={label}
                    disabled={disabled}
                />
                <span className={styles.tokenPill}>
                    <span className={styles.tokenDot}>
                        <StrkCoin size={22} />
                    </span>
                    STRK
                </span>
            </div>
            <div className={styles.subLine}>
                <span>{hint}</span>
                {detail ? <span className={styles.subMono}>{detail}</span> : null}
            </div>
        </div>
    );
}
