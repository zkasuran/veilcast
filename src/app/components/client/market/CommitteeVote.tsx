"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../../../uni.module.css";
import {
    type Ballot,
    type Committee,
    VOID_CHOICE,
    loadBallot,
    loadCommittee,
    loadTally,
    voteCall,
} from "@/utils/committee";
import type { MarketView } from "@/utils/market";
import { formatTimeLeft } from "@/utils/veilcast";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, errorMessage, useStrk20 } from "../strk20/useStrk20";

/// The panel for a market a jury settles.
///
/// Nobody here has a casting vote. A fixed panel was named when the market opened, and the first
/// choice to reach the quorum settles it, void included. Everyone sees the jury and every vote it
/// casts, which is the same split the rest of Veilcast runs on: the resolution is public so it can
/// be checked, and what stays private is who bet.
export default function CommitteeVote({ view, onSettled }: { view: MarketView; onSettled: () => void }) {
    const strk20 = useStrk20();
    const [committee, setCommittee] = useState<Committee>();
    const [tally, setTally] = useState<{ perOutcome: number[]; void: number }>();
    const [ballot, setBallot] = useState<Ballot>();
    const [note, setNote] = useState("");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    const { provider, committeeAddress, address } = strk20;
    const load = useCallback(async () => {
        try {
            const bound = await loadCommittee(provider, committeeAddress, view.id);
            setCommittee(bound);
            if (!bound) return;
            setTally(await loadTally(provider, committeeAddress, view.id, bound.nOutcomes));
            setBallot(address ? await loadBallot(provider, committeeAddress, view.id, address) : undefined);
            setNote("");
        } catch (failure) {
            setNote(`Could not read the panel: ${errorMessage(failure)}`);
        }
    }, [provider, committeeAddress, view.id, address]);

    useEffect(() => {
        void load();
    }, [load]);

    async function castVote(choice: number) {
        setResult(null);
        setBusy(true);
        try {
            const label = choice === VOID_CHOICE ? "void" : (view.labels[choice] ?? `outcome ${choice}`);
            const txHash = await strk20.execute(
                [voteCall(committeeAddress, view.id, choice)],
                setResult,
                `vote ${label} on #${view.id}`
            );
            if (txHash) {
                onSettled();
                void load();
            }
        } finally {
            setBusy(false);
        }
    }

    // Not a committee market, so this panel has nothing to say.
    if (!committee) {
        return note ? <div className={styles.resolverNote}>{note}</div> : null;
    }

    const now = Math.floor(Date.now() / 1000);
    const open = now >= view.closeAt && !committee.decided && view.state === "Open";
    const canVote = open && ballot?.isJuror === true && ballot.hasVoted === false;

    return (
        <div className={styles.resolverBox}>
            <div className={styles.resolverHead}>
                Settled by a jury of {committee.nJurors}, {committee.quorum} to agree
            </div>

            <div className={styles.tallyRows}>
                {view.labels.map((label, outcome) => (
                    <div key={outcome} className={styles.tallyRow}>
                        <span className={styles.tallyLabel}>
                            {label}
                            {ballot?.hasVoted && ballot.choice === outcome ? " · your vote" : ""}
                        </span>
                        <span className={styles.tallyCount}>
                            {tally?.perOutcome[outcome] ?? 0} / {committee.quorum}
                        </span>
                        {canVote ? (
                            <button className={`${styles.btn} ${styles.btnGreen}`} disabled={busy} onClick={() => castVote(outcome)}>
                                Vote {label}
                            </button>
                        ) : null}
                    </div>
                ))}
                <div className={styles.tallyRow}>
                    <span className={styles.tallyLabel}>
                        Void the market{ballot?.hasVoted && ballot.choice === VOID_CHOICE ? " · your vote" : ""}
                    </span>
                    <span className={styles.tallyCount}>
                        {tally?.void ?? 0} / {committee.quorum}
                    </span>
                    {canVote ? (
                        <button className={styles.btn} disabled={busy} onClick={() => castVote(VOID_CHOICE)}>
                            Vote void
                        </button>
                    ) : null}
                </div>
            </div>

            <div className={styles.resolverNote}>{status(committee, ballot, view, now)}</div>
            {note ? <div className={styles.resolverNote}>{note}</div> : null}
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}

function status(committee: Committee, ballot: Ballot | undefined, view: MarketView, now: number): string {
    if (committee.decided || view.state !== "Open") return "The panel has decided. This market is settled.";
    if (now < view.closeAt) {
        return `Voting opens when the market closes, in ${formatTimeLeft(view.closeAt, now)}. A juror judges the result after the event.`;
    }
    if (!ballot?.isJuror) return "Voting is open. Only the named jurors can settle it.";
    if (ballot.hasVoted) return "Your vote is in. It settles once a choice reaches the quorum.";
    return "You are on this panel. Cast your vote above.";
}
