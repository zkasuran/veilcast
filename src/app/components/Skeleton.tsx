"use client";

import styles from "../uni.module.css";

/**
 * Skeleton loading placeholders — pulsing rectangles that show while data loads.
 * Three variants match the main content areas: board cards, position rows, and a
 * single market detail panel.
 */

function Bone({ width = "100%", height = 14 }: { width?: string | number; height?: number }) {
    return (
        <span
            className={styles.skeleton}
            style={{ width, height, display: "inline-block", borderRadius: 8 }}
        />
    );
}

/** A skeleton card matching the shape of a MarketCard. */
function MarketCardSkeleton() {
    return (
        <div className={`${styles.marketCard} ${styles.skeletonCard}`} aria-hidden>
            <div className={styles.marketHead}>
                <Bone width="70%" height={18} />
                <Bone width={60} height={24} />
            </div>
            <div className={styles.outcomes} style={{ marginTop: 14 }}>
                <div className={styles.outcome} style={{ pointerEvents: "none" }}>
                    <Bone width="50%" height={14} />
                    <Bone width="100%" height={5} />
                </div>
                <div className={styles.outcome} style={{ pointerEvents: "none" }}>
                    <Bone width="40%" height={14} />
                    <Bone width="100%" height={5} />
                </div>
            </div>
            <div className={styles.marketFoot} style={{ marginTop: 12 }}>
                <Bone width={80} height={12} />
                <Bone width={100} height={12} />
            </div>
        </div>
    );
}

/** Three skeleton cards for the board loading state. */
export function BoardSkeleton() {
    return (
        <div className={styles.panelWide} aria-label="Loading markets…" role="status">
            <MarketCardSkeleton />
            <MarketCardSkeleton />
            <MarketCardSkeleton />
        </div>
    );
}

/** Skeleton for the positions panel (3 position rows). */
export function PositionsSkeleton() {
    return (
        <div className={styles.panelWide} aria-label="Loading positions…" role="status">
            {[0, 1, 2].map((i) => (
                <div key={i} className={`${styles.positionRow} ${styles.skeletonCard}`} aria-hidden>
                    <Bone width="60%" height={16} />
                    <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
                        <Bone width={80} height={12} />
                        <Bone width={60} height={12} />
                        <Bone width={90} height={12} />
                    </div>
                </div>
            ))}
        </div>
    );
}

/** Skeleton for a single market detail page. */
export function MarketDetailSkeleton() {
    return (
        <div className={styles.panelWide} aria-label="Loading market…" role="status">
            <div className={`${styles.marketCard} ${styles.skeletonCard}`} aria-hidden>
                <Bone width="80%" height={22} />
                <div style={{ marginTop: 16 }}>
                    <Bone width="100%" height={120} />
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                    <Bone width={100} height={36} />
                    <Bone width={100} height={36} />
                </div>
            </div>
            <div className={`${styles.factRows} ${styles.skeletonCard}`} style={{ marginTop: 16 }} aria-hidden>
                <Bone width="40%" height={14} />
                <Bone width="60%" height={14} />
                <Bone width="50%" height={14} />
            </div>
        </div>
    );
}
