"use client";

import { useEffect, useState } from "react";
import styles from "../uni.module.css";

const SEEN_KEY = "veilcast.onboarded.v1";

const STEPS: { title: string; body: string }[] = [
    {
        title: "Visible odds, invisible bettors",
        body: "Veilcast is a prediction market on Starknet. The volume on each outcome is public, so the odds mean something. Who placed each bet is not, so the odds stay honest.",
    },
    {
        title: "Shield once, then bet privately",
        body: "You deposit STRK into the STRK20 pool once, in the open. After that a bet is withdrawn from the pool into the market by a shared relayer, so the market is handed an amount and an outcome and never your address.",
    },
    {
        title: "A bet is a coupon you keep",
        body: "Each bet mints a key that lives only in this browser. It is the one thing that can collect the payout, so back it up from the Positions tab. Whoever holds it holds the money.",
    },
    {
        title: "Amounts are public, on purpose",
        body: "A market with hidden sizes cannot produce real odds. Veilcast hides who, never how much. Read the repo before you trust that, and never treat a shield deposit as private.",
    },
];

/// A one-time walkthrough of the one thing that surprises people: the split between what is public
/// (amounts, odds, resolutions) and what is not (who). Shown once per browser, dismissable, and
/// re-openable from the footer, so it informs without nagging.
export default function Onboarding() {
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState(0);

    useEffect(() => {
        try {
            if (window.localStorage.getItem(SEEN_KEY) !== "1") setOpen(true);
        } catch {
            // A browser with storage blocked just does not get the first-run prompt.
        }
    }, []);

    useEffect(() => {
        function reopen() {
            setStep(0);
            setOpen(true);
        }
        window.addEventListener("veilcast:show-intro", reopen);
        return () => window.removeEventListener("veilcast:show-intro", reopen);
    }, []);

    function close() {
        setOpen(false);
        try {
            window.localStorage.setItem(SEEN_KEY, "1");
        } catch {
            // If it cannot be recorded, the worst case is the prompt shows again next time.
        }
    }

    if (!open) return null;
    const last = step === STEPS.length - 1;
    const current = STEPS[step];

    return (
        <div className={styles.modalOverlay} onClick={close}>
            <div className={styles.introModal} onClick={(event) => event.stopPropagation()}>
                <div className={styles.introDots}>
                    {STEPS.map((_unused, index) => (
                        <span
                            key={index}
                            className={`${styles.introDot} ${index === step ? styles.introDotOn : ""}`}
                        />
                    ))}
                </div>
                <h2 className={styles.introTitle}>{current.title}</h2>
                <p className={styles.introBody}>{current.body}</p>
                <div className={styles.introActions}>
                    <button className={styles.btn} onClick={close}>
                        Skip
                    </button>
                    {last ? (
                        <button className={styles.btnCta} onClick={close}>
                            Start
                        </button>
                    ) : (
                        <button className={styles.btnCta} onClick={() => setStep((value) => value + 1)}>
                            Next
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
