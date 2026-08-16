"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../../../uni.module.css";
import { loadStake } from "@/utils/market";
import { type Coupon, couponsBackup, importCoupons, loadCoupons } from "@/utils/veilcast";
import PositionRow from "./PositionRow";
import { useBoard } from "./useBoard";
import { errorMessage, useStrk20 } from "../strk20/useStrk20";

/// Everything this browser holds a coupon for.
///
/// The list itself is local. Nothing on-chain ties a position to an account, so there is no address
/// to look positions up by: the coupon in localStorage is the claim. That is the whole point, and it
/// is also the risk, which is why the backup is one click from here.
export default function PositionsPanel() {
    const strk20 = useStrk20();
    const { markets, refresh: refreshBoard } = useBoard();
    const [coupons, setCoupons] = useState<Coupon[]>([]);
    const [stakes, setStakes] = useState<Record<string, bigint>>({});
    const [note, setNote] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setCoupons(loadCoupons());
    }, []);

    const readStakes = useCallback(async () => {
        if (!strk20.hasMarket || coupons.length === 0) return;
        try {
            const pairs = await Promise.all(
                coupons.map(
                    async (coupon) =>
                        [
                            coupon.positionKey,
                            await loadStake(
                                strk20.provider,
                                strk20.marketAddress,
                                coupon.marketId,
                                coupon.outcome,
                                coupon.positionKey
                            ),
                        ] as const
                )
            );
            setStakes(Object.fromEntries(pairs));
            setNote("");
        } catch (failure) {
            setNote(`Could not read positions from the chain: ${errorMessage(failure)}`);
        }
    }, [coupons, strk20.hasMarket, strk20.marketAddress, strk20.provider]);

    useEffect(() => {
        void readStakes();
    }, [readStakes]);

    function reload() {
        setCoupons(loadCoupons());
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

    const ordered = [...coupons].sort((left, right) => right.createdAt - left.createdAt);

    return (
        <div className={styles.panelWide}>
            <div className={styles.boardHead}>
                <span className={styles.boardCount}>
                    {coupons.length === 0 ? "No positions in this browser" : `${coupons.length} positions`}
                </span>
                <button className={styles.btn} onClick={reload}>
                    Refresh
                </button>
                <button className={styles.btn} onClick={download} disabled={coupons.length === 0}>
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

            {coupons.length === 0 ? (
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
                    stake={stakes[coupon.positionKey] ?? BigInt(coupon.amount)}
                    onClaimed={reload}
                />
            ))}
        </div>
    );
}
