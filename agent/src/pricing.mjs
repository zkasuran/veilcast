/// Pure arithmetic: the FPMM and the leverage maths, ported from cairo/src/pricing.cairo and
/// cairo/src/leveraged_market.cairo felt for felt.
///
/// Nothing here touches the network, so an agent can quote, plan and decide for free before it
/// spends anything. Every rounding step matches the contract, including the directions that favor
/// the pool, so a number computed here is the number the chain will compute. The Cairo suite is the
/// source of truth; `test/pricing.test.mjs` pins these against the same vectors.

import { RISK } from "./config.mjs";

const BPS = BigInt(RISK.bps);

/// Floor integer square root, the bigint mirror of Cairo's `u256` sqrt.
export function isqrt(value) {
    if (value < 0n) throw new Error("isqrt of a negative");
    if (value < 2n) return value;
    let guess = value;
    let next = (guess + 1n) / 2n;
    while (next < guess) {
        guess = next;
        next = (guess + value / guess) / 2n;
    }
    return guess;
}

/// Marginal price of the bought outcome in basis points: `rOther / (rBought + rOther)`, rounded
/// down. An empty book reads as an even 5000 and the two sides always sum to a coin.
export function priceBps(rBought, rOther) {
    const total = rBought + rOther;
    if (total === 0n) return 5000;
    return Number((rOther * BPS) / total);
}

/// Buy `amount` of collateral worth of the bought outcome. Shares out round down and the reserve the
/// pool keeps rounds up, so the constant product never shrinks.
export function buy(rBought, rOther, amount) {
    if (amount <= 0n) throw new Error("buy amount must be positive");
    const denominator = rOther + amount;
    const ending = (rBought * rOther + denominator - 1n) / denominator; // ceiling division
    return { sharesOut: rBought + amount - ending, newBought: ending, newOther: rOther + amount };
}

/// Sell `shares` of the sold outcome back to the pool. Collateral out rounds down, so the pool never
/// pays more than the invariant allows.
export function sell(rSold, rOther, shares) {
    if (shares <= 0n) throw new Error("sell shares must be positive");
    const sum = rSold + shares + rOther;
    const discriminant = sum * sum - 4n * shares * rOther;
    const rootCeil = isqrt(discriminant) + 1n;
    const numerator = sum > rootCeil ? sum - rootCeil : 0n;
    const out = numerator / 2n;
    return { amountOut: out, newSold: rSold + shares - out, newOther: rOther - out };
}

/// The (bought, other) reserves for a side, so YES trades against NO and NO against YES.
export function sidesOf(market, side) {
    return side === 0
        ? { rBought: market.rYes, rOther: market.rNo }
        : { rBought: market.rNo, rOther: market.rYes };
}

/// What opening `margin` at `leverageBps` on a side would do, computed exactly as `do_open`.
///
/// Returns the notional, the vault borrow, the open fee, the shares the FPMM mints and the price
/// before and after, so an agent can decide whether the entry is worth taking before it spends gas.
export function quoteOpen(market, side, margin, leverageBps) {
    const notional = (margin * BigInt(leverageBps)) / BigInt(RISK.leverageOne);
    const borrowed = notional - margin;
    const fee = (notional * BigInt(RISK.openFeeBps)) / BPS;
    const invested = notional - fee;
    const { rBought, rOther } = sidesOf(market, side);
    const { sharesOut, newBought, newOther } = buy(rBought, rOther, invested);
    return {
        notional,
        borrowed,
        fee,
        invested,
        shares: sharesOut,
        entryPriceBps: priceBps(rBought, rOther),
        priceAfterBps: priceBps(newBought, newOther),
    };
}

/// A position marked to the live book, computed exactly as `position_equity`.
///
/// `healthBps` is equity over notional. At or below the maintenance floor a keeper may liquidate,
/// which is the number a keeper loop scans on.
export function markPosition(market, side, position) {
    if (position.state !== "Open" || position.shares === 0n) {
        return { value: 0n, equity: 0n, healthBps: 0, pnl: 0n, liquidatable: false };
    }
    const { rBought, rOther } = sidesOf(market, side);
    const { amountOut: value } = sell(rBought, rOther, position.shares);
    const notional = position.margin + position.borrowed;
    const equity = value > position.borrowed ? value - position.borrowed : 0n;
    const healthBps = notional === 0n ? 0 : Number((equity * BPS) / notional);
    return {
        value,
        equity,
        healthBps,
        pnl: equity - position.margin,
        liquidatable: healthBps <= RISK.maintenanceMarginBps,
    };
}

/// Whether a mandate's band is met at the live price and which half fired.
///
/// This is the same test `do_agent_close` runs on-chain, so an agent can check for free rather than
/// spending gas to be told MANDATE_NOT_MET. A zero band is disabled, matching the contract.
export function mandateStatus(market, side, mandate) {
    const { rBought, rOther } = sidesOf(market, side);
    const price = priceBps(rBought, rOther);
    const hasAgent = mandate.agentKey !== "0x0" && BigInt(mandate.agentKey ?? 0) !== 0n;
    const stopHit = mandate.stopPriceBps !== 0 && price <= mandate.stopPriceBps;
    const takeHit = mandate.takePriceBps !== 0 && price >= mandate.takePriceBps;
    return {
        priceBps: price,
        hasAgent,
        stopHit,
        takeHit,
        firable: hasAgent && (stopHit || takeHit),
        reason: !hasAgent
            ? "no mandate on this position"
            : stopHit
              ? "stop reached"
              : takeHit
                ? "take reached"
                : "price is inside the band, nothing to do",
    };
}

/// The keeper's reward for liquidating a position, capped by the surplus the sale actually produced,
/// exactly as `liquidate` computes it. An agent uses this to decide whether a liquidation pays for
/// its own gas before sending it.
export function keeperReward(position, mark) {
    const notional = position.margin + position.borrowed;
    const uncapped = (notional * BigInt(RISK.keeperRewardBps)) / BPS;
    const surplus = mark.value > position.borrowed ? mark.value - position.borrowed : 0n;
    return uncapped < surplus ? uncapped : surplus;
}

/// Format a smallest-unit amount as STRK, trimmed, for a human-readable line in a report.
export function formatStrk(amount, maxFractionDigits = 4) {
    const unit = 10n ** 18n;
    const whole = amount < 0n ? -((-amount) / unit) : amount / unit;
    const rest = amount < 0n ? -amount % unit : amount % unit;
    const fraction = rest.toString().padStart(18, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
    const sign = amount < 0n && whole === 0n ? "-" : "";
    return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/// Parse a STRK amount into the smallest unit or null for anything that is not a positive number.
/// Agents pass amounts as strings and a bad one must be refused rather than coerced.
export function parseStrk(input) {
    const trimmed = String(input).trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
    const [whole, fraction = ""] = trimmed.split(".");
    if (fraction.length > 18) return null;
    const amount = BigInt(whole === "" ? "0" : whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    return amount > 0n ? amount : null;
}
