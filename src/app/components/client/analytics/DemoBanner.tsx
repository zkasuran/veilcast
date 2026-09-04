"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import neon from "../../../neon.module.css";
import { useBoardContext } from "../market/BoardContext";
import { setDemoEnabled } from "@/utils/demoBoard";

/// A slim dismissible strip shown only while the app is running on the demo (seeded) board. It makes
/// the boundary explicit: everything here is client-side sample data, and the real product appears
/// once the current network has a deployed Veilcast market.
export default function DemoBanner() {
    const { demo, refresh } = useBoardContext();
    const [hidden, setHidden] = useState(false);
    if (!demo || hidden) return null;

    return (
        <div className={styles.demoBanner}>
            <span className={styles.demoPill}>demo</span>
            <span>
                <b>Sample data — nothing here is on chain.</b> This is the product preview shown when a
                network has no deployed Veilcast market. Set your market address (or deploy one) and
                this swaps to live markets automatically.
            </span>
            <button
                onClick={() => {
                    setDemoEnabled(false);
                    setHidden(true);
                    void refresh();
                }}
            >
                Turn off demo
            </button>
        </div>
    );
}
