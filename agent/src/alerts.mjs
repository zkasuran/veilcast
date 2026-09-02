/// Alerts: the state changes worth interrupting somebody over, derived from chain rather than pushed.
///
/// A web coding host cannot run a background daemon, so there is nothing to push into. Instead every
/// alert is *derived on demand* from the same reads `keeper-scan`, `mandate-scan` and `vault` already do,
/// which means an alert can never go stale or fire twice for a condition that has since resolved. The
/// host asks, the answer is computed from the current block.
///
/// The engine is pure. It takes already-fetched state and returns typed alerts, so the severity rules
/// are testable without a network and cannot drift between the CLI, the MCP server and a webhook.

/// Severity, in the order an operator should read them.
///
/// `critical` means money is at risk right now and a human should look. `warning` means something will
/// cost money if ignored. `info` is an opportunity rather than a problem. Nothing else exists on
/// purpose: a scale with five levels gets three of them ignored.
export const SEVERITY = { critical: 3, warning: 2, info: 1 };

/// One alert. `id` is stable for a given condition, so a host that has already shown an alert can
/// recognise the same one on the next poll rather than re-notifying.
function alert(severity, id, title, detail, action) {
    return { severity, id, title, detail, ...(action ? { action } : {}) };
}

/// Every alert the current state justifies, most severe first.
///
/// Inputs are optional because a caller may not have permission or reason to fetch all of them: an
/// operator with no agent key has no mandates to check. A project with no LP position has no
/// withdrawal to warn about. A missing input produces no alerts rather than a false all-clear.
export function deriveAlerts({ vault, keeper, mandates, lp, chain } = {}) {
    const out = [];

    // Solvency first. This is the invariant the Cairo suite fuzzes, so seeing it false on mainnet means
    // something the tests do not model, which is worth a full stop rather than a warning.
    if (vault && vault.solvent === false) {
        out.push(
            alert(
                "critical",
                "vault-insolvent",
                "The vault does not cover its obligations",
                `Balance ${vault.balance} against free + backing + insurance of ${vault.obligations}. This is the invariant the contract test suite fuzzes, so it failing on chain means something the tests do not model.`,
                "Stop trading and report it. Do not open new positions."
            )
        );
    }

    // A mandate at the maintenance floor is the time-sensitive case: if the agent does not fire the
    // stop, a keeper liquidates and the owner pays a penalty a stop would have avoided.
    const racing = (mandates?.mandates ?? []).filter((entry) => entry.firable && entry.alsoLiquidatable);
    for (const entry of racing) {
        out.push(
            alert(
                "critical",
                `mandate-racing-${entry.marketId}-${entry.side}-${entry.positionKey}`,
                "A firable stop is about to be liquidated instead",
                `Market ${entry.marketId} ${entry.side === 0 ? "YES" : "NO"} is at ${entry.healthBps} bps health and its band is met. A liquidation charges the owner a penalty that a stop does not.`,
                "Fire it now: veilcast-agent agent-close --market <id> --side <side> --key <key> --confirm"
            )
        );
    }

    const firable = (mandates?.mandates ?? []).filter((entry) => entry.firable && !entry.alsoLiquidatable);
    if (firable.length > 0) {
        out.push(
            alert(
                "warning",
                "mandates-firable",
                `${firable.length} mandate${firable.length === 1 ? "" : "s"} reached the granted band`,
                firable
                    .map(
                        (entry) =>
                            `market ${entry.marketId} ${entry.side === 0 ? "YES" : "NO"} at ${entry.priceBps} bps (${entry.stopHit ? "stop" : "take"} hit)`
                    )
                    .join("; "),
                "The owner asked for this price. Fire it: veilcast-agent agent-close --market <id> --side <side> --key <key> --confirm"
            )
        );
    }

    // Insurance shrinking is the early signal that liquidations across the whole market are arriving
    // late, which matters to an LP more than their own position does.
    if (vault && vault.insurance === 0n && vault.backing > 0n) {
        out.push(
            alert(
                "warning",
                "insurance-empty",
                "The insurance fund is empty while loans are outstanding",
                `Backing is ${vault.backing} with no insurance behind it. The next liquidation that closes below the borrow becomes bad debt against LP capital.`,
                "Watch it rather than acting: insurance refills from liquidation surpluses."
            )
        );
    }

    if (vault && vault.free === 0n) {
        out.push(
            alert(
                "info",
                "vault-dry",
                "The vault cannot lend",
                "Free collateral is zero, so no new leveraged position can open until a position closes or an LP provides.",
                "Provide liquidity. Otherwise wait."
            )
        );
    }

    // An LP whose shares are worth more than the vault can pay is the one case that looks like a bug and
    // is not. Saying it as an alert stops it being discovered as a revert.
    if (lp && lp.shares > 0n && lp.quote && lp.quote.payable === false) {
        out.push(
            alert(
                "info",
                "lp-not-payable",
                "Your vault shares are not fully withdrawable right now",
                `They are worth ${lp.worth} but only ${lp.withdrawableNow} is payable: the collateral behind them is lent out or seeded into a market.`,
                "Withdraw a smaller slice. Otherwise wait for positions to close."
            )
        );
    }

    if (lp && lp.result && lp.result.pnl < 0n) {
        out.push(
            alert(
                "info",
                "lp-underwater",
                "Your liquidity position is below what you put in",
                `Deposited ${lp.result.deposited}, withdrawn ${lp.result.withdrawn}, currently worth ${lp.worth}.`,
                "Informational. The vault earns borrow fees over time. A loss here means liquidations closed below their borrow."
            )
        );
    }

    // Keeper opportunities are money on the table rather than a problem, so they sit at info even when
    // there are many of them.
    if (keeper && keeper.liquidatable > 0) {
        const best = keeper.candidates?.[0];
        out.push(
            alert(
                "info",
                "keeper-work",
                `${keeper.liquidatable} position${keeper.liquidatable === 1 ? "" : "s"} liquidatable now`,
                best
                    ? `Best pays ${best.reward} on market ${best.marketId} ${best.side === 0 ? "YES" : "NO"}.`
                    : "Run keeper-scan for the list.",
                "A keeper only earns if the reward clears its gas: veilcast-agent keeper-scan --min-reward 0.5"
            )
        );
    }

    out.sort((left, right) => SEVERITY[right.severity] - SEVERITY[left.severity]);
    return {
        alerts: out,
        counts: {
            critical: out.filter((a) => a.severity === "critical").length,
            warning: out.filter((a) => a.severity === "warning").length,
            info: out.filter((a) => a.severity === "info").length,
        },
        // The block the answer was derived at, so a host can tell a fresh poll from a cached one.
        ...(chain ? { atBlock: chain.head } : {}),
        quiet: out.length === 0,
    };
}
