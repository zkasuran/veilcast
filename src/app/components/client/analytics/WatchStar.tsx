"use client";

import styles from "../../../neon.module.css";

/// A little star that follows a market from the board to the analytics to your shortlist. It lives
/// per browser only, so following never changes anything on-chain.
export default function WatchStar({
    watched,
    onToggle,
    title = "Follow this market",
}: {
    watched: boolean;
    onToggle: () => void;
    title?: string;
}) {
    return (
        <button
            className={`${styles.watchBtn} ${watched ? styles.watcher : ""}`}
            aria-pressed={watched}
            aria-label={watched ? "Unfollow this market" : title}
            title={watched ? "Unfollow" : title}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggle();
            }}
        >
            {watched ? "★" : "☆"}
        </button>
    );
}
