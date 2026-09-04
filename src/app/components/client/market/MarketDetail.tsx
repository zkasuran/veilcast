"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { num } from "starknet";
import styles from "../../../uni.module.css";
import { voyagerContractUrl } from "@/utils/constants";
import { categoryLabel, marketStatus } from "@/utils/discovery";
import { collectFeeCall } from "@/utils/market";
import { formatStrk } from "@/utils/veilcast";
import BetForm from "./BetForm";
import ActivityFeed from "./ActivityFeed";
import CommitteeVote from "./CommitteeVote";
import FeedSettle from "./FeedSettle";
import MarketCard from "./MarketCard";
import OddsChart from "./OddsChart";
import PositionRow from "./PositionRow";
import ResolverControls from "./ResolverControls";
import ResultCard from "../strk20/ResultCard";
import MarketReadCard from "../analytics/MarketReadCard";
import WatchStar from "../analytics/WatchStar";
import { useWatchlist } from "../analytics/useWatchlist";
import { useBoard } from "./useBoard";
import { useMarketHistory } from "./useMarketHistory";
import { usePositions } from "./usePositions";
import { deriveAnalytics } from "@/utils/analytics";
import { type ActionResult, shortHex, useStrk20 } from "../strk20/useStrk20";

/// One market, deep-linkable, which is what a market gets shared as.
///
/// Everything here is read from the chain: the question, the volumes, the terms and who can settle
/// it. The only local thing on the page is your own coupons for this market, because nothing
/// on-chain connects a position to an account that could be looked up.
export default function MarketDetail() {
    const params = useSearchParams();
    const idParam = params.get("id");
    const id = idParam !== null && /^\d+$/.test(idParam) ? Number(idParam) : undefined;

    const strk20 = useStrk20();
    const { markets, error, loading, refresh, demo } = useBoard();
    const positions = usePositions(id);
    const watch = useWatchlist();
    const [outcome, setOutcome] = useState<number | undefined>();
    const [copied, setCopied] = useState(false);
    const [feeBusy, setFeeBusy] = useState(false);
    const [feeResult, setFeeResult] = useState<ActionResult | null>(null);

    async function payFee() {
        if (!view) return;
        setFeeResult(null);
        setFeeBusy(true);
        try {
            const txHash = await strk20.execute(
                [collectFeeCall(strk20.marketAddress, view.id)],
                setFeeResult,
                `${formatStrk(view.feeOwed)} STRK fee`
            );
            if (txHash) {
                void refresh();
                void history.reload();
            }
        } finally {
            setFeeBusy(false);
        }
    }

    const view = markets.find((market) => market.id === id);
    const history = useMarketHistory(id, view?.labels.length ?? 0);
    const read = view ? deriveAnalytics([view])[0] : undefined;

    function isResolver(): boolean {
        if (!view || !strk20.address || view.state !== "Open") return false;
        try {
            return num.toBigInt(view.resolver) === num.toBigInt(strk20.address);
        } catch {
            return false;
        }
    }

    function isFeedBound(): boolean {
        if (!view || !strk20.hasResolver) return false;
        try {
            return num.toBigInt(view.resolver) === num.toBigInt(strk20.resolverAddress);
        } catch {
            return false;
        }
    }

    function isCommitteeBound(): boolean {
        if (!view || !strk20.hasCommittee) return false;
        try {
            return num.toBigInt(view.resolver) === num.toBigInt(strk20.committeeAddress);
        } catch {
            return false;
        }
    }

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // A browser that refuses the clipboard is not an error worth a red box.
        }
    }

    if (id === undefined) {
        return (
            <div className={styles.panelWide}>
                <div className={styles.notice}>
                    That link has no market id on it. <Link href="/">Back to the board</Link>.
                </div>
            </div>
        );
    }

    if (!view) {
        return (
            <div className={styles.panelWide}>
                <div className={styles.notice}>
                    {loading
                        ? "Reading the chain…"
                        : error
                        ? `Could not read the board: ${error}`
                        : `Market #${id} is not on ${strk20.networkName ?? "this network"}.`}{" "}
                    <Link href="/">Back to the board</Link>.
                </div>
            </div>
        );
    }

    const escrowed = view.volumes.reduce((sum, volume) => sum + volume, 0n);

    return (
        <div className={styles.panelWide}>
            <div className={styles.detailTop}>
                <Link className={styles.backLink} href="/">
                    ← Board
                </Link>
                <button className={styles.btn} onClick={() => void copyLink()}>
                    {copied ? "Link copied" : "Copy link"}
                </button>
            </div>

            {demo ? <span className={styles.demoPill}>demo market · not on chain</span> : null}
            <MarketCard
                view={view}
                providerIndex={strk20.providerIndex}
                marketAddress={strk20.marketAddress}
                selectedOutcome={outcome}
                onSelectOutcome={setOutcome}
                watchNode={<WatchStar watched={watch.has(view.id)} onToggle={() => watch.toggle(view.id)} />}
                readOnly={demo}
            >
                {outcome !== undefined ? (
                    <BetForm
                        view={view}
                        outcome={outcome}
                        onPlaced={() => {
                            setOutcome(undefined);
                            void refresh();
                            void history.reload();
                            positions.reload();
                        }}
                    />
                ) : null}
                {isResolver() ? <ResolverControls view={view} onSettled={refresh} /> : null}
                {isFeedBound() && view.state === "Open" ? (
                    <FeedSettle view={view} onSettled={refresh} />
                ) : null}
                {isCommitteeBound() ? <CommitteeVote view={view} onSettled={refresh} /> : null}
            </MarketCard>

            {read ? (
                <div className={styles.detailSection}>
                    <h2 className={styles.detailHead}>Radar read</h2>
                    <MarketReadCard
                        read={read}
                        watched={watch.has(view.id)}
                        onToggleWatch={watch.toggle}
                    />
                </div>
            ) : null}

            <div className={styles.detailSection}>
                <h2 className={styles.detailHead}>How the odds moved</h2>
                {history.error ? (
                    <div className={styles.warn}>Could not read the market's events: {history.error}</div>
                ) : (
                    <OddsChart points={history.points} labels={view.labels} />
                )}
            </div>

            <div className={styles.detailSection}>
                <h2 className={styles.detailHead}>Your positions here</h2>
                {positions.coupons.length === 0 ? (
                    <div className={styles.notice}>
                        No coupon in this browser for this market. A bet writes one, and it is the only
                        thing that can collect the payout.
                    </div>
                ) : (
                    positions.coupons.map((coupon) => (
                        <PositionRow
                            key={coupon.positionKey}
                            coupon={coupon}
                            view={view}
                            stake={positions.stakeOf(coupon)}
                            onClaimed={() => {
                                positions.reload();
                                void refresh();
                            }}
                        />
                    ))
                )}
                {positions.error ? <div className={styles.warn}>{positions.error}</div> : null}
            </div>

            <div className={styles.detailSection}>
                <h2 className={styles.detailHead}>Activity</h2>
                <ActivityFeed
                    events={history.events}
                    labels={view.labels}
                    providerIndex={strk20.providerIndex}
                    loading={history.loading}
                    error={history.error}
                />
            </div>

            <div className={styles.detailSection}>
                <h2 className={styles.detailHead}>On chain</h2>
                <div className={styles.factRows}>
                    <Fact label="Market" value={`#${view.id}`} />
                    <Fact label="Section" value={categoryLabel(view.category)} />
                    <Fact label="Status" value={marketStatus(view)} />
                    <Fact label="Opened" value={new Date(view.createdAt * 1000).toLocaleString()} />
                    <Fact label="Closes" value={new Date(view.closeAt * 1000).toLocaleString()} />
                    <Fact label="Outcomes" value={view.labels.join(", ")} />
                    <Fact label="Pot" value={`${formatStrk(view.pot)} STRK`} />
                    <Fact label="Staked per outcome" value={`${formatStrk(escrowed)} STRK`} />
                    <Fact
                        label="Fee"
                        value={
                            view.feeBps === 0
                                ? "none, the winning side splits the whole pot"
                                : `${view.feeBps / 100}% of the pot, once, at settlement`
                        }
                    />
                    {view.feeOwed > 0n ? (
                        <Fact label="Fee owed" value={`${formatStrk(view.feeOwed)} STRK`} />
                    ) : null}
                    <Fact
                        label="Resolver"
                        value={shortHex(view.resolver)}
                        href={voyagerContractUrl(strk20.providerIndex, view.resolver)}
                    />
                    <Fact
                        label="Market contract"
                        value={shortHex(strk20.marketAddress)}
                        href={voyagerContractUrl(strk20.providerIndex, strk20.marketAddress)}
                    />
                </div>
            </div>

            {view.feeOwed > 0n ? (
                <div className={styles.detailSection}>
                    <h2 className={styles.detailHead}>Fee to pay out</h2>
                    <div className={styles.notice}>
                        This market settled owing {formatStrk(view.feeOwed)} STRK to the address it was
                        opened with. Anyone can send that payment, the destination was fixed when the
                        market opened, and the sender only pays the fee for the transaction.
                    </div>
                    <button
                        className={`${styles.btn} ${styles.btnGreen} ${styles.btnBlock}`}
                        disabled={feeBusy || !strk20.isConnected}
                        onClick={() => void payFee()}
                    >
                        {feeBusy ? "Paying…" : `Pay the ${formatStrk(view.feeOwed)} STRK fee`}
                    </button>
                    {feeResult ? (
                        <ResultCard result={feeResult} providerIndex={strk20.providerIndex} />
                    ) : null}
                </div>
            ) : null}

            <div className={styles.detailSection}>
                <h2 className={styles.detailHead}>What this page publishes</h2>
                <div className={styles.notice}>
                    Every number above is public and always was: the volumes are the price signal, so
                    hiding them would leave the odds meaningless. What is not here, and is not on the
                    chain either, is who placed any of it. A bet arrives through the pool's relayer and
                    the market is handed an amount, an outcome and a fresh key it has never seen.
                </div>
            </div>
        </div>
    );
}

function Fact({ label, value, href }: { label: string; value: string; href?: string }) {
    return (
        <div className={styles.factRow}>
            <span className={styles.factLabel}>{label}</span>
            {href ? (
                <a className={styles.factLink} href={href} target="_blank" rel="noreferrer">
                    {value} ↗
                </a>
            ) : (
                <span className={styles.factValue}>{value}</span>
            )}
        </div>
    );
}
