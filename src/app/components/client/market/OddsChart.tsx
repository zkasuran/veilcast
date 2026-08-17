"use client";

import { useState } from "react";
import styles from "../../../uni.module.css";
import type { OddsPoint } from "@/utils/events";
import { formatStrk } from "@/utils/veilcast";

// Slots from the validated categorical palette, in the order that clears the colour-vision gates.
// Never cycled: a ninth outcome cannot exist, because the contract caps a market at eight.
const SERIES = [
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-3)",
    "var(--series-4)",
    "var(--series-5)",
    "var(--series-6)",
    "var(--series-7)",
    "var(--series-8)",
];

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { top: 14, right: 108, bottom: 28, left: 38 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const GRID = [0, 0.25, 0.5, 0.75, 1];

/// How the odds moved, rebuilt from the market's own `BetPlaced` events.
///
/// The x axis is the market's bets in the order they landed rather than a clock: the events carry a
/// block, not a timestamp, and spacing by block would draw a gap that means nothing. Each line is
/// one outcome's share of the pot, which is the market's implied probability for it.
export default function OddsChart({ points, labels }: { points: OddsPoint[]; labels: string[] }) {
    const [active, setActive] = useState<number>();

    if (points.length === 0) {
        return (
            <div className={styles.notice}>
                No bets yet, so there is no history to draw. The first bet sets the odds.
            </div>
        );
    }

    const last = points[points.length - 1];
    const x = (index: number) =>
        PAD.left + (points.length <= 1 ? PLOT_W : (PLOT_W * (index - 1)) / (points.length - 1));
    const y = (probability: number) => PAD.top + PLOT_H * (1 - probability);

    const path = (outcome: number) =>
        points
            .map(
                (point, position) =>
                    `${position === 0 ? "M" : "L"}${x(point.index).toFixed(1)},${y(point.probabilities[outcome] ?? 0).toFixed(1)}`
            )
            .join(" ");

    // Direct labels are the relief for the palette's sub-3:1 slots, so they have to stay readable:
    // sorted by where each line ends, then pushed apart when two outcomes finish close together.
    const endLabels = labels
        .map((label, outcome) => ({ label, outcome, y: y(last.probabilities[outcome] ?? 0) }))
        .sort((left, right) => left.y - right.y);
    for (let index = 1; index < endLabels.length; index += 1) {
        const minimum = endLabels[index - 1].y + 13;
        if (endLabels[index].y < minimum) endLabels[index].y = minimum;
    }

    const hovered = active !== undefined ? points[active] : undefined;

    function trackPointer(event: React.MouseEvent<SVGSVGElement>) {
        const box = event.currentTarget.getBoundingClientRect();
        const localX = ((event.clientX - box.left) / box.width) * WIDTH;
        const ratio = (localX - PAD.left) / PLOT_W;
        const nearest = Math.round(ratio * (points.length - 1));
        setActive(Math.min(points.length - 1, Math.max(0, nearest)));
    }

    return (
        <div className={styles.chart}>
            <svg
                className={styles.chartSvg}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                role="img"
                aria-label={`Implied probability after each of ${points.length} bets. Now: ${labels
                    .map((label, outcome) => `${label} ${Math.round((last.probabilities[outcome] ?? 0) * 100)}%`)
                    .join(", ")}.`}
                onMouseMove={trackPointer}
                onMouseLeave={() => setActive(undefined)}
            >
                {GRID.map((line) => (
                    <g key={line}>
                        <line
                            className={styles.chartGrid}
                            x1={PAD.left}
                            x2={PAD.left + PLOT_W}
                            y1={y(line)}
                            y2={y(line)}
                        />
                        <text className={styles.chartTick} x={PAD.left - 8} y={y(line)} textAnchor="end">
                            {Math.round(line * 100)}%
                        </text>
                    </g>
                ))}

                {hovered ? (
                    <line
                        className={styles.chartCrosshair}
                        x1={x(hovered.index)}
                        x2={x(hovered.index)}
                        y1={PAD.top}
                        y2={PAD.top + PLOT_H}
                    />
                ) : null}

                {labels.map((label, outcome) => (
                    <path
                        key={outcome}
                        className={styles.chartLine}
                        d={path(outcome)}
                        stroke={SERIES[outcome % SERIES.length]}
                    />
                ))}

                {hovered
                    ? labels.map((label, outcome) => (
                        <circle
                            key={outcome}
                            className={styles.chartDot}
                            cx={x(hovered.index)}
                            cy={y(hovered.probabilities[outcome] ?? 0)}
                            r={5}
                            fill={SERIES[outcome % SERIES.length]}
                        />
                    ))
                    : null}

                {endLabels.map((entry) => (
                    <text
                        key={entry.outcome}
                        className={styles.chartLabel}
                        x={PAD.left + PLOT_W + 10}
                        y={entry.y}
                        dominantBaseline="middle"
                    >
                        <tspan fill={SERIES[entry.outcome % SERIES.length]}>■ </tspan>
                        {entry.label} {Math.round((last.probabilities[entry.outcome] ?? 0) * 100)}%
                    </text>
                ))}

                <text className={styles.chartTick} x={PAD.left} y={HEIGHT - 8}>
                    first bet
                </text>
                <text
                    className={styles.chartTick}
                    x={PAD.left + PLOT_W}
                    y={HEIGHT - 8}
                    textAnchor="end"
                >
                    {points.length} bets
                </text>
            </svg>

            {hovered ? (
                <div className={styles.chartTip}>
                    <span className={styles.chartTipHead}>
                        Bet {hovered.index} · block {hovered.blockNumber} · pot{" "}
                        {formatStrk(hovered.pot)} STRK
                    </span>
                    {labels.map((label, outcome) => (
                        <span key={outcome} className={styles.chartTipRow}>
                            <span
                                className={styles.chartSwatch}
                                style={{ background: SERIES[outcome % SERIES.length] }}
                            />
                            {label}
                            <b>{Math.round((hovered.probabilities[outcome] ?? 0) * 100)}%</b>
                            <span className={styles.chartTipVolume}>
                                {formatStrk(hovered.volumes[outcome] ?? 0n)} STRK
                            </span>
                        </span>
                    ))}
                </div>
            ) : null}

            <details className={styles.chartTable}>
                <summary>Table of every bet</summary>
                <table>
                    <thead>
                        <tr>
                            <th>Bet</th>
                            <th>Block</th>
                            {labels.map((label) => (
                                <th key={label}>{label}</th>
                            ))}
                            <th>Pot</th>
                        </tr>
                    </thead>
                    <tbody>
                        {points.map((point) => (
                            <tr key={point.index}>
                                <td>{point.index}</td>
                                <td>{point.blockNumber}</td>
                                {labels.map((label, outcome) => (
                                    <td key={label}>
                                        {Math.round((point.probabilities[outcome] ?? 0) * 100)}%
                                    </td>
                                ))}
                                <td>{formatStrk(point.pot)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
        </div>
    );
}
