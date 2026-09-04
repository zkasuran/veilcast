"use client";

import type { MarketView } from "./market";
import { impliedProbability, payoutMultiple, formatStrk } from "./veilcast";

/// The intelligence panel is deliberately on-device: it never uploads the board, never needs an API
/// key and never invents a confidence it cannot explain. It is an ensemble of independent analyst
/// lenses — the same way Veilcast treats resolution as a set of independent signals rather than one
/// trusted oracle. Each lens sees the same public data and answers one question, then a small
/// aggregate layer weighs them by how much liquidity is behind the answer.
///
/// Nothing here is a promise. Every number is derived from public on-chain volume and is exactly as
/// good as the crowd behind it. A thin book produces a "low confidence" model verdict, not a strong
/// one.

const STRK_UNIT = 10n ** 18n;

export type AnalysisLensId = "momentum" | "value" | "flow" | "risk" | "sentiment";

export type AnalysisLens =
    | { id: "momentum"; name: "Momentum"; score: number; note: string; bias: AnalysisBias }
    | { id: "value"; name: "Value"; score: number; note: string; bias: AnalysisBias }
    | { id: "flow"; name: "Flow"; score: number; note: string; bias: AnalysisBias }
    | { id: "risk"; name: "Risk"; score: number; note: string; bias: AnalysisBias }
    | { id: "sentiment"; name: "Sentiment"; score: number; note: string; bias: AnalysisBias };

export type AnalysisBias = "yes" | "no" | "neutral";

export type AnalysisVerdict = "Strong YES" | "YES" | "Neutral" | "NO" | "Strong NO" | "No signal";

export type MarketAnalysis = {
    marketId: number;
    question: string;
    category: string;
    outcome: number;
    label: string;
    volume: bigint;
    pot: bigint;
    implied: number;
    payout: number;
    /// Expected return of a stake on this outcome, net of the stake, given the current odds and the
    /// market's fee. Positive is "the crowd is paying more than fair", negative is "you are paying
    /// the crowd's premium".
    edge: number;
    hoursLeft: number;
    closingSoon: boolean;
    confidence: number;
    risk: number;
    score: number;
    verdict: AnalysisVerdict;
    lenses: AnalysisLens[];
    oneLiner: string;
};

export type BoardAnalysis = {
    markets: MarketAnalysis[];
    totalPot: bigint;
    openMarkets: number;
    busiest: MarketAnalysis | undefined;
    bestValue: MarketAnalysis | undefined;
    riskiest: MarketAnalysis | undefined;
    aggregate: AnalysisVerdict;
    aggregateCount: number;
    updatedAt: number;
};

/// Every open market's best reading, in one pass. `now` is injectable so the tests can pin the clock.
export function deriveAnalytics(markets: MarketView[], now = Math.floor(Date.now() / 1000)): MarketAnalysis[] {
    const open = markets.filter(
        (view) => view.state === "Open" && view.closeAt > now
    );
    const reads: MarketAnalysis[] = [];
    for (const view of open) {
        const best = bestMarketAnalysis(view, now);
        if (best) reads.push(best);
    }
    return reads.sort(
        (left, right) =>
            right.score - left.score ||
            cmpBig(right.pot, left.pot) ||
            cmpBig(right.volume, left.volume) ||
            left.marketId - right.marketId
    );
}

/// The strongest one-outcome read on a single market.
export function bestMarketAnalysis(view: MarketView, now = Math.floor(Date.now() / 1000)): MarketAnalysis | undefined {
    if (view.state !== "Open" || view.closeAt <= now) return undefined;
    const hoursLeft = (view.closeAt - now) / 3600;

    let best: MarketAnalysis | undefined;
    for (let outcome = 0; outcome < view.labels.length; outcome += 1) {
        const read = readForOutcome(view, outcome, hoursLeft, now);
        if (!best || better(read, best)) best = read;
    }
    return best;
}

function better(left: MarketAnalysis, right: MarketAnalysis): boolean {
    // A higher score wins. Ties resolve toward the side with more liquidity behind it, then the
    // outcome with the lower id so the panel is stable between reads.
    return (
        left.score > right.score ||
        (left.score === right.score &&
            (left.volume > right.volume ||
                (left.volume === right.volume && left.outcome < right.outcome)))
    );
}

function readForOutcome(
    view: MarketView,
    outcome: number,
    hoursLeft: number,
    now: number
): MarketAnalysis {
    const volume = view.volumes[outcome] ?? 0n;
    const pot = view.pot === 0n ? volume + volume + 1n : view.pot;
    const implied = impliedProbability(volume, view.pot, view.labels.length);
    const payout = payoutMultiple(volume, view.pot, STRK_UNIT, view.feeBps);
    const edge = (implied * payout) - 1;

    const nOutcomes = Math.max(2, view.labels.length);
    const even = 1 / nOutcomes;
    const flowShare = view.pot === 0n ? even : Number((volume * 10_000n) / view.pot) / 10_000;
    const dominance = (flowShare - even) / Math.max(0.25, even);
    const momentumRaw = clamp(dominance, -1, 1);

    const stakes = Number(formatStrk(volume));
    const confidence = clamp(0.25 + Math.log10(Math.max(1, stakes + 1)) / 4.25, 0.05, 0.95);
    const timeRisk = clamp(1 - hoursLeft / (24 * 7), 0, 1);
    const risk = clamp(0.45 * timeRisk + 0.3 * (1 - confidence) + (edge < 0 ? 0.2 : 0), 0, 1);

    const momentumScore = scoreFromBias(momentumRaw);
    const valueScore = scoreFromBias(clamp(edge * 4, -1, 1));
    const flowScore = scoreFromBias(clamp(dominance * 1.4, -1, 1));

    // Risk is inverted: a calm, liquid, long-dated market scores high on the risk lens.
    const riskScore = Math.round((1 - risk) * 100);

    // Sentiment is the crowd price itself, damped toward neutral on a thin book and toward the safe
    // equilibrium when the book is empty.
    const sentimentRaw = view.pot === 0n ? 0 : (flowShare - even) / Math.max(even, 0.001);
    const sentimentScore = Math.round(
        50 + clamp(sentimentRaw * 35, -45, 45) * confidence
    );

    // Consensus score: the weighted ensemble, biased by confidence so a thin book cannot shout.
    const score = Math.round(
        0.28 * momentumScore + 0.26 * valueScore + 0.16 * flowScore + 0.12 * riskScore + 0.18 * sentimentScore
    );
    const verdict = verdictFromScore(score, confidence, view.pot);

    return {
        marketId: view.id,
        question: view.question,
        category: view.category,
        outcome,
        label: view.labels[outcome] ?? `outcome ${outcome}`,
        volume,
        pot: view.pot,
        implied,
        payout,
        edge,
        hoursLeft,
        closingSoon: hoursLeft <= 6,
        confidence,
        risk,
        score,
        verdict,
        lenses: [
            {
                id: "momentum",
                name: "Momentum",
                score: momentumScore,
                note:
                    momentumRaw > 0.35
                        ? `${formatStrk(volume)} STRK is flowing in, crowding past the even split.`
                        : momentumRaw < -0.35
                        ? `Volume is thin behind this side → the other side is carrying the book.`
                        : `No lopsided flow yet; the book is close to evenly split.`,
                bias: biasFromScore(momentumScore),
            },
            {
                id: "value",
                name: "Value",
                score: valueScore,
                note:
                    edge > 0.05
                        ? `Expected return ≈ ${(edge * 100).toFixed(1)}% above the stake at current odds.`
                        : edge < -0.05
                        ? `You would be paying ≈ ${Math.abs(edge * 100).toFixed(1)}% over fair odds here.`
                        : `Odds are close to fair once fees are counted.`,
                bias: biasFromScore(valueScore),
            },
            {
                id: "flow",
                name: "Flow",
                score: flowScore,
                note:
                    flowShare > even * 1.5
                        ? `The side carries ${(flowShare * 100).toFixed(0)}% of the pot.`
                        : `The side carries ${(flowShare * 100).toFixed(0)}% of the pot — near balance.`,
                bias: biasFromScore(flowScore),
            },
            {
                id: "risk",
                name: "Risk",
                score: riskScore,
                note: timeRisk > 0.5
                    ? `Only ${formatHours(hoursLeft)} left — the clock is the largest risk factor.`
                    : `${formatHours(hoursLeft)} remaining gives the answer room to move.`,
                bias: biasFromScore(riskScore),
            },
            {
                id: "sentiment",
                name: "Sentiment",
                score: sentimentScore,
                note:
                    view.pot === 0n
                        ? `The book is still empty, so the crowd has not expressed an opinion.`
                        : `The crowd prices it at ${(implied * 100).toFixed(1)}%.`,
                bias: biasFromScore(sentimentScore),
            },
        ],
        oneLiner: oneLiner(readForOutcomeRaw(view, outcome, hoursLeft, now, score, verdict, confidence)),
    };
}

// Kept separate so oneLiner can be built after the final score without re-deriving the whole object.
function readForOutcomeRaw(
    view: MarketView,
    outcome: number,
    hoursLeft: number,
    now: number,
    score: number,
    verdict: AnalysisVerdict,
    confidence: number
): { view: MarketView; outcome: number; hoursLeft: number; score: number; verdict: AnalysisVerdict; confidence: number } {
    return { view, outcome, hoursLeft, score, verdict, confidence };
}

function oneLiner(raw: {
    view: MarketView;
    outcome: number;
    hoursLeft: number;
    score: number;
    verdict: AnalysisVerdict;
    confidence: number;
}): string {
    const label = raw.view.labels[raw.outcome] ?? `outcome ${raw.outcome}`;
    const price = Math.round(
        impliedProbability(raw.view.volumes[raw.outcome] ?? 0n, raw.view.pot, raw.view.labels.length) * 100
    );
    const pay = payoutMultiple(raw.view.volumes[raw.outcome] ?? 0n, raw.view.pot, STRK_UNIT, raw.view.feeBps).toFixed(2);
    return `${label} reads ${price}% (${pay}x) with a ${raw.score}/100 ensemble confidence of ${Math.round(
        raw.confidence * 100
    )}% · closes in ${formatHours(raw.hoursLeft)}.`;
}

/// Board-level aggregation the dashboard can render without re-reading the chain.
export function boardAnalytics(reads: MarketAnalysis[], updatedAt = Date.now()): BoardAnalysis {
    const totalPot = reads.reduce((sum, read) => sum + read.pot, 0n);
    const busiest = [...reads].sort((left, right) => cmpBig(right.pot, left.pot) || cmpBig(right.volume, left.volume))[0];
    const bestValue = [...reads].sort((left, right) => right.edge - left.edge || right.confidence - left.confidence)[0];
    const riskiest = [...reads].sort((left, right) => right.risk - left.risk || right.edge - left.edge)[0];
    const aggregate = aggregateVerdict(reads);
    const aggregateCount = reads.filter((read) => read.verdict === aggregate).length;
    return {
        markets: reads,
        totalPot,
        openMarkets: reads.length,
        busiest,
        bestValue,
        riskiest,
        aggregate,
        aggregateCount,
        updatedAt,
    };
}

function aggregateVerdict(reads: MarketAnalysis[]): AnalysisVerdict {
    if (reads.length === 0) return "No signal";
    const tally: Record<AnalysisVerdict, number> = {
        "Strong YES": 0,
        YES: 0,
        Neutral: 0,
        NO: 0,
        "Strong NO": 0,
        "No signal": 0,
    };
    for (const read of reads) {
        tally[read.verdict] += 1;
    }
    const top = (Object.entries(tally) as [AnalysisVerdict, number][]).sort(
        (left, right) => right[1] - left[1] || right[0].localeCompare(left[0])
    )[0];
    return top?.[0] ?? "No signal";
}

function verdictFromScore(score: number, confidence: number, pot: bigint): AnalysisVerdict {
    if (pot === 0n) return "No signal";
    const damped = 50 + (score - 50) * (0.35 + confidence * 0.65);
    if (damped >= 82) return "Strong YES";
    if (damped >= 60) return "YES";
    if (damped <= 18) return "Strong NO";
    if (damped <= 40) return "NO";
    return "Neutral";
}

function biasFromScore(score: number): AnalysisBias {
    if (score >= 62) return "yes";
    if (score <= 38) return "no";
    return "neutral";
}

function scoreFromBias(value: number): number {
    return Math.round(50 + value * 50);
}

function formatHours(hours: number): string {
    const minutes = Math.max(1, Math.round(hours * 60));
    return minutes < 60 ? `${minutes}m` : `${Math.round((minutes / 60) * 10) / 10}h`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function cmpBig(left: bigint, right: bigint): number {
    return left === right ? 0 : left > right ? 1 : -1;
}
