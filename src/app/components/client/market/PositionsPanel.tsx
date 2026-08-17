"use client";

import { useRef, useState } from "react";
import styles from "../../../uni.module.css";
import { couponsBackup, importCoupons } from "@/utils/veilcast";
import PositionRow from "./PositionRow";
import { useBoard } from "./useBoard";
import { usePositions } from "./usePositions";
import { useStrk20 } from "../strk20/useStrk20";

/// Everything this browser holds a coupon for.
///
/// The list is local. Nothing on-chain ties a position to an account, so there is no address to look
/// positions up by: the coupon in localStorage is the claim. That is the whole point. It is also the
/// risk, which is why the backup is one click from here.
export default function PositionsPanel() {
    const strk20 = useStrk20();
    const { markets, refresh: refreshBoard } = useBoard();
    const positions = usePositions();
    const [note, setNote] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);

    function reload() {
        positions.reload();
        void refreshBoard();
    }

    function download() {
        const url = URL.createObjectURL(new Blob([couponsBackup()], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `veilcast-coupons-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
    }

    async function restore(file: File | undefined) {
        if (!file) return;
        const merged = importCoupons(await file.text());
        setNote(
            merged === null
                ? "That file is not a Veilcast coupon backup."
                : `Restored ${merged.added} new coupons, ${merged.total} in this browser.`
        );
        if (merged) reload();
    }

    const ordered = [...positions.coupons].sort((left, right) => right.createdAt - left.createdAt);
    const claimable = ordered.filter((coupon) => {
        const view = markets.find((market) => market.id === coupon.marketId);
        if (!view || positions.stakeOf(coupon) === 0n) return false;
        return view.state === "Void" || (view.state === "Resolved" && view.winningOutcome === coupon.outcome);
    }).length;

    return (
        <div className={styles.panelWide}>
            <div className={styles.boardHead}>
                <span className={styles.boardCount}>
                    {positions.coupons.length === 0
                        ? "No positions in this browser"
                        : `${positions.coupons.length} positions${claimable > 0 ? `, ${claimable} to collect` : ""}`}
                </span>
                <button className={styles.btn} onClick={reload}>
                    Refresh
                </button>
                <button
                    className={styles.btn}
                    onClick={download}
                    disabled={positions.coupons.length === 0}
                >
                    Back up coupons
                </button>
                <button className={styles.btn} onClick={() => fileInput.current?.click()}>
                    Restore
                </button>
                <input
                    ref={fileInput}
                    className={styles.hiddenInput}
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => void restore(event.target.files?.[0])}
                />
            </div>

            {note ? <div className={styles.notice}>{note}</div> : null}
            {positions.error ? <div className={styles.warn}>{positions.error}</div> : null}

            {positions.coupons.length === 0 ? (
                <div className={styles.notice}>
                    A bet writes its coupon here. The coupon is a keypair generated in this browser and
                    stored nowhere else, so back it up: whoever holds it collects the payout, and nobody
                    who does not can.
                </div>
            ) : null}

            {ordered.map((coupon) => (
                <PositionRow
                    key={coupon.positionKey}
                    coupon={coupon}
                    view={markets.find((market) => market.id === coupon.marketId)}
                    stake={positions.stakeOf(coupon)}
                    href={`/market/?id=${coupon.marketId}`}
                    onClaimed={reload}
                />
            ))}
        </div>
    );
}
