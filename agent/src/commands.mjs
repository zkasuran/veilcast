/// Every command the CLI exposes, as plain async functions returning a result envelope.
///
/// Split by risk: reads are free and need no keys, writes are dry-run by default and need a funding
/// account. Each write reports what it WOULD do in enough detail that an agent can check the plan
/// before re-running with `--confirm`.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT, fail, note, ok } from "./result.mjs";
import { ENV_KEYS, isDeployed } from "./config.mjs";
import {
    agentPublicKey,
    assertNotOwnerKey,
    ensureAgentKey,
    loadFundingAccount,
    paths,
    readAgentKey,
} from "./keys.mjs";
import {
    classHashAt,
    levBoard,
    levMandate,
    levMarketCount,
    levPosition,
    liquidityHistory,
    proveBlock,
    quoteRemoveLiquidity,
    receiptFacts,
    countsUnderProgramRule,
    tokenBalance,
    vaultShares,
    vaultState,
} from "./chain.mjs";
import {
    formatStrk,
    keeperReward,
    lpResult,
    mandateStatus,
    markPosition,
    parseStrk,
    priceBps,
    quoteOpen,
    sharePrice,
} from "./pricing.mjs";
import {
    SIDE_NO,
    SIDE_YES,
    agentCloseCalldata,
    betCalldata,
    closeToAddressCalldata,
    mandate as buildMandate,
    newCoupon,
    noMandate,
    openCalldata,
} from "./calldata.mjs";
import { approvePool, openSession, poolBet, poolInvoke, poolOpen, shield } from "./pool.mjs";
import { betHistory, board, market, payoutMultiple, quotePayout } from "./market.mjs";
import { scanKeeper, scanMandates } from "./scan.mjs";
import { writeSkills } from "./install.mjs";

/// Parse a side argument. Accepts the words a human or an LLM would naturally use, because "yes" is
/// what a model writes and 0 is what the contract wants.
function parseSide(value) {
    const text = String(value ?? "").toLowerCase();
    if (text === "0" || text === "yes" || text === "long") return SIDE_YES;
    if (text === "1" || text === "no" || text === "short") return SIDE_NO;
    const error = new Error(`Bad side "${value}". Use yes or no (0 or 1).`);
    error.code = "BAD_SIDE_ARG";
    throw error;
}

/// Parse leverage. Accepts "3x", "3" or raw basis points, since all three appear in the wild.
function parseLeverage(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (/^\d+(\.\d+)?x$/.test(text)) return Math.round(Number.parseFloat(text) * 10_000);
    const number = Number(text);
    if (!Number.isFinite(number)) {
        const error = new Error(`Bad leverage "${value}". Use 3x, 3 or 30000 (basis points).`);
        error.code = "BAD_LEVERAGE_ARG";
        throw error;
    }
    return number <= 50 ? Math.round(number * 10_000) : Math.round(number);
}

/// Require an amount in STRK and return it in the smallest unit.
function requireAmount(value, field) {
    const parsed = parseStrk(value ?? "");
    if (parsed === null) {
        const error = new Error(`${field} must be a positive STRK amount, got "${value}".`);
        error.code = "BAD_AMOUNT";
        throw error;
    }
    return parsed;
}

/// Require the leveraged market to be deployed, with a reason rather than an obscure RPC failure.
function requireLeverage(config, command) {
    if (isDeployed(config.leverage)) return;
    const error = new Error(
        "The leveraged market is not deployed on this network yet. Set VEILCAST_LEVERAGE or --leverage once it is."
    );
    error.code = "LEVERAGE_NOT_DEPLOYED";
    error.command = command;
    throw error;
}

/// Load the funding account that pays gas and submits pool transactions.
///
/// The agent never owns this key; the operator points at an sncast accounts file and the runtime reads
/// the one named account. Everything money-related needs it and every read works without it.
function requireFunding(args) {
    const accountsPath = args.accounts ?? process.env.VEILCAST_ACCOUNTS;
    const accountName = args.account ?? process.env.VEILCAST_ACCOUNT;
    if (!accountsPath || !accountName) {
        const error = new Error(
            "This command sends a transaction, so it needs a funding account: --accounts <sncast accounts.json> --account <name> (or VEILCAST_ACCOUNTS and VEILCAST_ACCOUNT)."
        );
        error.code = "NO_FUNDING_ACCOUNT";
        throw error;
    }
    return loadFundingAccount(accountsPath, accountName);
}

/// Whether this invocation is allowed to spend. Dry run is the default everywhere.
function isConfirmed(args) {
    return args.confirm === true || args.confirm === "true";
}
// PLACEHOLDER_READS

/// Where this agent stands: what it is pointed at, whether the services answer, what it may do.
///
/// The first command any agent should run. It never fails on a missing key or SDK; it reports them as
/// capabilities it does not have yet, which is what an agent needs in order to decide what to try.
export async function status({ config, args }) {
    const probes = await probeEndpoints(config);
    const keyState = keyStatus(config);
    const leverageLive = isDeployed(config.leverage);
    let chain = null;
    if (probes.rpc.ok) {
        const { head, proveAt } = await proveBlock(config);
        chain = { head, proveAt, proveLag: config.proveLag };
    }
    let solvency = null;
    if (leverageLive && probes.rpc.ok) {
        const state = await vaultState(config);
        solvency = {
            free: state.free,
            backing: state.backing,
            insurance: state.insurance,
            balance: state.balance,
            solvent: state.solvent,
        };
    }
    const canRead = probes.rpc.ok;
    const canWrite = canRead && probes.proving.ok && probes.discovery.ok && Boolean(config.sdkPath);
    return ok(
        "status",
        {
            network: config.network,
            endpoints: {
                rpc: config.rpcUrl,
                proving: config.provingUrl,
                discovery: config.discoveryUrl,
            },
            probes,
            chain,
            contracts: {
                pool: config.pool,
                token: config.token,
                market: config.market,
                leverage: config.leverage,
                leverageDeployed: leverageLive,
            },
            solvency,
            agentKey: keyState,
            privacySdk: config.sdkPath ? { path: config.sdkPath, set: true } : { set: false },
            capabilities: {
                read: canRead,
                quote: true,
                shieldAndTrade: canWrite,
                fireMandates: canWrite && leverageLive && keyState.present,
                liquidate: canWrite && leverageLive,
            },
            cannot: [
                "redirect a payout: an agent close pays the address the owner pinned on-chain at open",
                "act outside its granted price band: the contract checks the live price",
                "widen its own mandate: a mandate is write-once at open, with no setter",
                "close a self-managed position: no mandate means no agent may act",
                "spend an owner's position: the owner's bearer key never reaches this runtime",
            ],
        },
        canWrite
            ? "Fully operational. Money commands are dry-run unless you pass --confirm."
            : "Read and quote work. For writes, set VEILCAST_PRIVACY_SDK and a funding account, then re-run doctor."
    );
    void args;
}

/// Diagnose a broken setup and name the exact fix for each problem.
///
/// Refuses to say "healthy" unless every check passes and every failure carries the command or the
/// environment variable that resolves it. An agent that cannot act should learn why from one call.
export async function doctor({ config }) {
    const checks = [];
    const probes = await probeEndpoints(config);
    checks.push({
        name: "rpc",
        ok: probes.rpc.ok,
        detail: probes.rpc.ok ? `head ${probes.rpc.head}` : probes.rpc.error,
        fix: probes.rpc.ok ? undefined : `Set ${ENV_KEYS.rpcUrl} to a working Starknet mainnet RPC.`,
    });
    checks.push({
        name: "proving-service",
        ok: probes.proving.ok,
        detail: probes.proving.ok ? "OHTTP key config served" : probes.proving.error,
        fix: probes.proving.ok ? undefined : `Check network egress or override ${ENV_KEYS.provingUrl}.`,
    });
    checks.push({
        name: "discovery-service",
        ok: probes.discovery.ok,
        detail: probes.discovery.ok ? "OHTTP key config served" : probes.discovery.error,
        fix: probes.discovery.ok ? undefined : `Check network egress or override ${ENV_KEYS.discoveryUrl}.`,
    });
    const keyState = keyStatus(config);
    checks.push({
        name: "agent-key",
        ok: keyState.present,
        detail: keyState.present ? `${keyState.publicKey.slice(0, 14)}… mode ${keyState.mode}` : "not generated",
        fix: keyState.present ? undefined : "Run: veilcast-agent init",
    });
    if (keyState.present && keyState.mode && keyState.mode !== "0600") {
        checks.push({
            name: "agent-key-permissions",
            ok: false,
            detail: `mode ${keyState.mode} is readable by others`,
            fix: `chmod 600 ${paths(config).agentKey}`,
        });
    }
    checks.push({
        name: "privacy-sdk",
        ok: Boolean(config.sdkPath) && existsSync(resolve(config.sdkPath ?? "")),
        detail: config.sdkPath ? config.sdkPath : "not set",
        fix: config.sdkPath
            ? undefined
            : `Set ${ENV_KEYS.sdkPath} to a built @starkware-libs/starknet-privacy-sdk. It is not on npm, so clone starkware-libs/starknet-privacy, then npm i && npm run build in its sdk directory. Read-only commands work without it.`,
    });
    checks.push({
        name: "leverage-contract",
        ok: isDeployed(config.leverage),
        detail: isDeployed(config.leverage) ? config.leverage : "not deployed on this network",
        fix: isDeployed(config.leverage) ? undefined : `Set ${ENV_KEYS.leverage} once it is deployed.`,
    });
    const failed = checks.filter((check) => !check.ok);
    const healthy = failed.length === 0;
    return {
        ok: healthy,
        command: "doctor",
        ...(healthy ? {} : { code: EXIT.notConfigured, error: "SETUP_INCOMPLETE" }),
        data: { healthy, checks, failed: failed.map((check) => check.name) },
        hint: healthy
            ? "Everything checks out. Money commands stay dry-run until you pass --confirm."
            : `Fix in order: ${failed.map((check) => check.fix).filter(Boolean).join(" | ")}`,
    };
}

/// The agent's public key, which is the only half anyone else needs.
///
/// An owner puts this into a mandate when opening a position. Handing it out is safe by construction:
/// on its own it cannot move money, because the payout address is pinned on-chain and the price band
/// is checked by the contract.
export async function agentKeyCommand({ config }) {
    const key = readAgentKey(config);
    return ok(
        "agent-key",
        {
            publicKey: key.publicKey,
            path: key.path,
            mode: key.mode,
            createdAt: key.createdAt,
        },
        "Give this public key to a position owner to name in a mandate. Never share the private half and never accept an owner's position key."
    );
}

/// Set an agent up from cold: generate its key, write the right skill files for its host, probe the
/// services and report exactly what it can do.
export async function init({ config, args }) {
    const key = ensureAgentKey(config, { rotate: args.rotate === true || args.rotate === "true" });
    const host = args.host ?? "auto";
    const written = writeSkills({ host, config, agentPublicKey: key.publicKey, force: args.force === true });
    const probes = await probeEndpoints(config);
    const ready = probes.rpc.ok && probes.proving.ok && probes.discovery.ok;
    const result = {
        agentKey: {
            publicKey: key.publicKey,
            path: key.path ?? paths(config).agentKey,
            created: key.created,
            rotated: Boolean(args.rotate) && key.created,
        },
        host: written.host,
        skillsWritten: written.files,
        probes,
        readyToRead: probes.rpc.ok,
        readyToWrite: ready && Boolean(config.sdkPath),
        nextSteps: [
            ...(config.sdkPath
                ? []
                : [`Set ${ENV_KEYS.sdkPath} to a built STRK20 privacy SDK to enable money commands.`]),
            "Point at a funding account with --accounts and --account (or VEILCAST_ACCOUNTS and VEILCAST_ACCOUNT).",
            "Run: veilcast-agent status",
        ],
    };
    if (!probes.rpc.ok) {
        return fail("init", EXIT.notConfigured, "PROBE_FAILED", "The agent was set up but mainnet is unreachable.", {
            hint: `Fix the RPC endpoint (${ENV_KEYS.rpcUrl}) then run: veilcast-agent doctor`,
        });
    }
    return ok("init", result, "Set up. Run status next and remember every money command needs --confirm to send.");
}

/// Reachability of the three services an agent depends on, each probed the cheapest honest way.
///
/// The OHTTP key-config endpoint is the right probe for proving and discovery: it is unauthenticated,
/// it returns the HPKE config a real request would use, so a 200 means the service will actually talk
/// to us rather than merely that a host resolves.
async function probeEndpoints(config) {
    const rpc = await probe(async () => {
        const response = await fetch(config.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_blockNumber", params: [] }),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        return { head: body.result };
    });
    const proving = await probe(async () => {
        const response = await fetch(`${config.provingUrl}/ohttp-keys`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return {};
    });
    const discovery = await probe(async () => {
        const response = await fetch(`${config.discoveryUrl}/ohttp-keys`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return {};
    });
    return { rpc, proving, discovery };
}

async function probe(run) {
    const started = Date.now();
    try {
        const extra = await run();
        return { ok: true, ms: Date.now() - started, ...extra };
    } catch (error) {
        return { ok: false, ms: Date.now() - started, error: String(error.message ?? error).slice(0, 200) };
    }
}

function keyStatus(config) {
    try {
        const key = readAgentKey(config);
        return { present: true, publicKey: key.publicKey, mode: key.mode, path: key.path };
    } catch {
        return { present: false };
    }
}
// PLACEHOLDER_MARKETS

/// The parimutuel board, fully decoded: questions, outcome labels, volumes, implied probabilities and
/// what a stake would pay. Amounts and odds are public by design, so this needs nothing but an RPC.
///
/// This is the half of Veilcast that is already live on mainnet, so it works with no deployment and no
/// keys. An agent can read the whole market and decide whether a bet is worth taking for free.
export async function markets({ config, args }) {
    const stake = args.stake ? requireAmount(args.stake, "--stake") : 10n ** 18n;
    const { count, markets: views } = await board(config);
    return ok(
        "markets",
        {
            market: config.market,
            count,
            quotedFor: stake,
            markets: views.map((view) => ({
                id: view.id,
                question: view.question,
                category: view.category,
                state: view.state,
                closeAt: view.closeAt,
                closesInHours: Math.round((view.closeAt - Date.now() / 1000) / 36) / 100,
                pot: view.pot,
                feeBps: view.feeBps,
                ...(view.state === "Resolved" ? { winningOutcome: view.winningOutcome } : {}),
                outcomes: view.outcomes.map((outcome) => ({
                    outcome: outcome.outcome,
                    label: outcome.label,
                    volume: outcome.volume,
                    impliedProbability: outcome.impliedProbability,
                    // What `--stake` would return if this outcome won, counting itself into the pot,
                    // which is the number that decides whether the bet is worth placing.
                    payout: quotePayout(view, outcome.outcome, stake),
                    multiple: payoutMultiple(view, outcome.outcome, stake),
                })),
                readable: {
                    pot: `${formatStrk(view.pot)} STRK`,
                    odds: view.outcomes
                        .map(
                            (outcome) =>
                                `${outcome.label} ${(outcome.impliedProbability * 100).toFixed(1)}% pays ${payoutMultiple(view, outcome.outcome, stake).toFixed(3)}x`
                        )
                        .join(", "),
                },
            })),
        },
        count === 0
            ? "No markets on this deployment yet."
            : `Odds quoted for a ${formatStrk(stake)} STRK stake. A multiple below 1.000 loses money even when it wins, so do not take it. Place one with: veilcast-agent bet --market <id> --outcome <n> --amount <STRK>`
    );
}

/// One market's bet flow, read from its own event log.
///
/// Every `BetPlaced` carries the running outcome volume, so this is the market's real odds history
/// rather than a replay of our arithmetic. No bet carries an address: the log holds an amount, an
/// outcome and a bearer position key, which is the privacy model visible in the data.
export async function flow({ config, args }) {
    const marketId = Number(args.market ?? 0);
    const view = await market(config, marketId);
    if (!view) {
        return fail("flow", EXIT.badRequest, "NO_SUCH_MARKET", `No market ${marketId} on this deployment.`);
    }
    const bets = await betHistory(config, marketId);
    return ok(
        "flow",
        {
            marketId,
            question: view.question,
            state: view.state,
            pot: view.pot,
            bets: bets.map((bet) => ({
                outcome: bet.outcome,
                label: view.labels[bet.outcome] ?? `outcome ${bet.outcome}`,
                amount: bet.amount,
                outcomeVolumeAfter: bet.outcomeVolume,
                positionKey: bet.positionKey,
                blockNumber: bet.blockNumber,
                txHash: bet.txHash,
                readable: `${formatStrk(bet.amount)} STRK on ${view.labels[bet.outcome] ?? bet.outcome}`,
            })),
        },
        bets.length === 0
            ? "No bets on this market yet, so the odds are still an even split."
            : `${bets.length} bet(s). Every one is an amount and a bearer key, with no address recorded anywhere.`
    );
}

/// The leveraged board with live prices, which is what an agent trades against.
export async function levMarkets({ config }) {
    requireLeverage(config, "lev-markets");
    const board = await levBoard(config);
    return ok(
        "lev-markets",
        {
            leverage: config.leverage,
            count: board.length,
            markets: board.map((market) => ({
                id: market.id,
                state: market.state,
                closeAt: market.closeAt,
                yesPriceBps: priceBps(market.rYes, market.rNo),
                noPriceBps: priceBps(market.rNo, market.rYes),
                liquidity: market.liquidity,
                borrowedYes: market.borrowedYes,
                borrowedNo: market.borrowedNo,
                resolver: market.resolver,
            })),
        },
        board.length === 0 ? "No leveraged markets yet." : "Quote an entry with: veilcast-agent quote"
    );
}

/// Vault solvency: the invariant that keeps the contract unable to owe more than it holds.
export async function vault({ config }) {
    requireLeverage(config, "vault");
    const state = await vaultState(config);
    return ok(
        "vault",
        {
            free: state.free,
            backing: state.backing,
            insurance: state.insurance,
            obligations: state.obligations,
            balance: state.balance,
            solvent: state.solvent,
            capital: state.capital,
            sharesTotal: state.sharesTotal,
            sharePrice: sharePrice(state.capital, state.sharesTotal),
            readable: {
                free: `${formatStrk(state.free)} STRK`,
                backing: `${formatStrk(state.backing)} STRK`,
                insurance: `${formatStrk(state.insurance)} STRK`,
                balance: `${formatStrk(state.balance)} STRK`,
                capital: `${formatStrk(state.capital)} STRK`,
                sharePrice: `${formatStrk(sharePrice(state.capital, state.sharesTotal))} STRK per share`,
            },
        },
        state.solvent
            ? "balance covers free + backing + insurance, which is the invariant the Cairo suite fuzzes."
            : "Balance does not cover obligations. Stop trading and report this."
    );
}

/// An LP's position in the vault: shares held, what they are worth, what a withdrawal would pay.
///
/// This exists because `remove_liquidity` takes shares rather than STRK. Without a quote an LP is
/// burning a unit it cannot value. The one way a correct withdrawal still reverts is free
/// collateral being short, which is a fact about the vault rather than about the LP. Both come from the
/// contract, so the number reported is the number the withdrawal will honour.
export async function vaultLp({ config, args }) {
    requireLeverage(config, "vault-lp");
    const lp = args.lp ?? args.address;
    if (!lp) {
        const error = new Error("Which liquidity provider? Pass --lp <address>.");
        error.code = "NO_LP_ADDRESS";
        throw error;
    }
    const [state, held] = await Promise.all([vaultState(config), vaultShares(config, lp)]);
    const price = sharePrice(state.capital, state.sharesTotal);
    const worth = (held * price) / 10n ** 18n;
    // Quoting the whole holding is the question an LP actually has. A smaller slice may well be payable
    // when the full one is not, so the refusal names that rather than reading as "your money is gone".
    const full = held > 0n ? await quoteRemoveLiquidity(config, held) : { amount: 0n, payable: false };
    const withdrawableNow = full.payable ? full.amount : state.free < worth ? state.free : worth;
    // Whether the position is up, which a share balance alone cannot say: shares are minted at the price
    // of the day, so the cost basis only exists in the log. Skipped when nothing is held and nothing was
    // ever withdrawn, since there is no history to read.
    const history = held > 0n || args.history ? await liquidityHistory(config, lp) : [];
    const result = history.length > 0 ? lpResult(history, worth) : null;
    return ok(
        "vault-lp",
        {
            lp,
            shares: held,
            sharesTotal: state.sharesTotal,
            ownershipBps: state.sharesTotal > 0n ? Number((held * 10_000n) / state.sharesTotal) : 0,
            sharePrice: price,
            worth,
            quote: full,
            withdrawableNow,
            result,
            events: history.length,
            vault: {
                free: state.free,
                backing: state.backing,
                insurance: state.insurance,
                capital: state.capital,
                solvent: state.solvent,
            },
            readable: {
                shares: formatStrk(held),
                sharePrice: `${formatStrk(price)} STRK per share`,
                worth: `${formatStrk(worth)} STRK`,
                withdrawableNow: `${formatStrk(withdrawableNow)} STRK`,
                ...(result
                    ? {
                          deposited: `${formatStrk(result.deposited)} STRK`,
                          withdrawn: `${formatStrk(result.withdrawn)} STRK`,
                          pnl: `${result.pnl < 0n ? "-" : "+"}${formatStrk(result.pnl < 0n ? -result.pnl : result.pnl)} STRK`,
                          averageEntry:
                              result.averageEntry === null
                                  ? "no deposits"
                                  : `${formatStrk(result.averageEntry)} STRK per share`,
                      }
                    : {}),
            },
        },
        held === 0n
            ? "This address holds no vault shares. `add_liquidity` is a public call, so anyone can provide."
            : full.payable
              ? "The whole holding is withdrawable right now."
              : "The shares are worth this much, but not all of it is payable: the collateral behind them is lent out or seeded into a market. Withdraw a smaller slice or wait for positions to close."
    );
}

/// One position, marked to the live book.
export async function position({ config, args }) {
    requireLeverage(config, "position");
    const side = parseSide(args.side);
    const market = await levMarketForArg(config, args.market);
    const key = await requireKey(config, args.key, market.id, side);
    const held = await levPosition(config, market.id, side, key);
    const mark = markPosition(market, side, held);
    const held_mandate = await levMandate(config, market.id, side, key);
    const status = mandateStatus(market, side, held_mandate);
    return ok(
        "position",
        {
            marketId: market.id,
            side,
            positionKey: key,
            state: held.state,
            margin: held.margin,
            borrowed: held.borrowed,
            notional: held.margin + held.borrowed,
            shares: held.shares,
            value: mark.value,
            equity: mark.equity,
            pnl: mark.pnl,
            healthBps: mark.healthBps,
            liquidatable: mark.liquidatable,
            priceBps: status.priceBps,
            readable: {
                margin: `${formatStrk(held.margin)} STRK`,
                equity: `${formatStrk(mark.equity)} STRK`,
                pnl: `${formatStrk(mark.pnl)} STRK`,
                health: `${(mark.healthBps / 100).toFixed(2)}%`,
            },
        },
        held.state !== "Open"
            ? `That position is ${held.state}.`
            : mark.liquidatable
              ? "At or below the maintenance floor: a keeper may liquidate it now."
              : "Open and above the maintenance floor."
    );
}

/// The authority a position carries, read from chain rather than taken on trust.
export async function mandateCommand({ config, args }) {
    requireLeverage(config, "mandate");
    const side = parseSide(args.side);
    const market = await levMarketForArg(config, args.market);
    const key = await requireKey(config, args.key, market.id, side);
    const held = await levMandate(config, market.id, side, key);
    const status = mandateStatus(market, side, held);
    const mine = keyStatus(config);
    const isMine = mine.present && BigInt(held.agentKey) === BigInt(mine.publicKey);
    return ok(
        "mandate",
        {
            marketId: market.id,
            side,
            positionKey: key,
            hasMandate: status.hasAgent,
            agentKey: held.agentKey,
            grantedToThisAgent: isMine,
            stopPriceBps: held.stopPriceBps,
            takePriceBps: held.takePriceBps,
            payoutTarget: held.payoutTarget,
            priceBps: status.priceBps,
            stopHit: status.stopHit,
            takeHit: status.takeHit,
            firable: status.firable && isMine,
            reason: status.reason,
        },
        !status.hasAgent
            ? "Self-managed: no agent can close this position."
            : !isMine
              ? "Mandated to a different agent. This runtime cannot fire it; the contract would refuse."
              : status.firable
                ? "Firable now: veilcast-agent agent-close"
                : "Granted to this agent, but the price is not in the band yet."
    );
}

/// What an open would do, computed exactly as the contract computes it. Free, so an agent should
/// always quote before it opens.
export async function quote({ config, args }) {
    requireLeverage(config, "quote");
    const side = parseSide(args.side);
    const margin = requireAmount(args.margin, "--margin");
    const leverageBps = parseLeverage(args.leverage ?? "2x");
    if (leverageBps < config.risk.leverageOne || leverageBps > config.risk.maxLeverage) {
        return fail("quote", EXIT.badRequest, "BAD_LEVERAGE", `Leverage must be between 1x and 5x, got ${leverageBps} bps.`, {
            hint: "Pass --leverage 3x or basis points between 10000 and 50000.",
        });
    }
    const market = await levMarketForArg(config, args.market);
    const quoted = quoteOpen(market, side, margin, leverageBps);
    const vaultNow = await vaultState(config);
    const affordable = vaultNow.free >= quoted.borrowed;
    return ok(
        "quote",
        {
            marketId: market.id,
            side,
            sideName: side === SIDE_YES ? "YES" : "NO",
            margin,
            leverageBps,
            notional: quoted.notional,
            borrowed: quoted.borrowed,
            openFee: quoted.fee,
            invested: quoted.invested,
            shares: quoted.shares,
            entryPriceBps: quoted.entryPriceBps,
            priceAfterBps: quoted.priceAfterBps,
            slippageBps: quoted.priceAfterBps - quoted.entryPriceBps,
            liquidationAtHealthBps: config.risk.maintenanceMarginBps,
            vaultFree: vaultNow.free,
            vaultCanLend: affordable,
            readable: {
                margin: `${formatStrk(margin)} STRK`,
                notional: `${formatStrk(quoted.notional)} STRK`,
                borrowed: `${formatStrk(quoted.borrowed)} STRK`,
                fee: `${formatStrk(quoted.fee)} STRK`,
                price: `${(quoted.entryPriceBps / 100).toFixed(2)}% -> ${(quoted.priceAfterBps / 100).toFixed(2)}%`,
            },
        },
        affordable
            ? "The vault can lend this. Open it with lev-open, which is a dry run until you add --confirm."
            : "The vault does not have enough free collateral for this borrow. Lower the leverage or the margin."
    );
}

/// Positions a keeper may liquidate right now, best paying first.
export async function keeperScan({ config, args }) {
    requireLeverage(config, "keeper-scan");
    const minReward = args["min-reward"] ? requireAmount(args["min-reward"], "--min-reward") : 0n;
    const scan = await scanKeeper(config, { minRewardWei: minReward });
    return ok(
        "keeper-scan",
        {
            ...scan,
            minReward,
            candidates: scan.candidates.map((entry) => ({
                ...entry,
                readable: {
                    reward: `${formatStrk(entry.reward)} STRK`,
                    health: `${(entry.healthBps / 100).toFixed(2)}%`,
                },
            })),
        },
        scan.liquidatable === 0
            ? "Nothing is liquidatable right now. Re-run later; this scan is free."
            : `${scan.liquidatable} liquidatable. Act with: veilcast-agent liquidate --market <id> --side <yes|no> --key <positionKey> --confirm`
    );
}

/// Mandates this agent holds and which of them are firable now.
export async function mandateScan({ config }) {
    requireLeverage(config, "mandate-scan");
    const mine = keyStatus(config);
    const scan = await scanMandates(config, mine.present ? mine.publicKey : undefined);
    return ok(
        "mandate-scan",
        { agentKey: mine.present ? mine.publicKey : null, ...scan },
        !mine.present
            ? "No agent key yet. Run init, then give the public key to a position owner."
            : scan.firable === 0
              ? "No mandate is in its band right now. Re-run later; this scan is free."
              : `${scan.firable} firable. Act with: veilcast-agent agent-close --market <id> --side <yes|no> --key <positionKey> --confirm`
    );
}

/// Validate a position key argument.
///
/// The custody check is deliberately sound rather than shape-based: a private key and a public key are
/// both field elements, so the only honest way to tell them apart is to derive the public half and ask
/// whether it owns a position on this market and side. If it does, the caller handed over a private
/// key and the command refuses.
async function requireKey(config, value, marketId, side) {
    if (!value || value === true) {
        const error = new Error("--key is required: the position's PUBLIC key.");
        error.code = "MISSING_KEY";
        throw error;
    }
    const key = String(value);
    await assertNotOwnerKey(key, async (derived) => {
        const held = await levPosition(config, marketId, side, derived);
        return held.state === "Open";
    });
    return key;
}

/// Resolve a market argument to a market, defaulting to the newest when none is named.
async function levMarketForArg(config, value) {
    const board = await levBoard(config);
    if (board.length === 0) {
        const error = new Error("No leveraged markets exist on this deployment yet.");
        error.code = "NO_MARKETS";
        throw error;
    }
    if (value === undefined || value === true) return board[0];
    const id = Number(value);
    const found = board.find((market) => market.id === id);
    if (!found) {
        const error = new Error(`No leveraged market ${id}. Available: ${board.map((m) => m.id).join(", ")}`);
        error.code = "NO_SUCH_MARKET";
        throw error;
    }
    return found;
}
// PLACEHOLDER_WRITES

/// Move STRK into the pool. `--first` for an account that has never used the pool.
///
/// The first deposit on a fresh account has to be the atomic register plus setup plus deposit and it
/// costs materially more than a later one because those one-time steps are expensive. Later deposits
/// need the previous note indexed first, which the runtime waits for.
export async function shieldCommand({ config, args }) {
    const amount = requireAmount(args.amount, "--amount");
    const funding = requireFunding(args);
    const confirmed = isConfirmed(args);
    const session = await openSession(config, funding);
    const first = args.first === true || args.first === "true";
    const plan = {
        action: "shield",
        amount,
        readable: `${formatStrk(amount)} STRK`,
        account: funding.address,
        first,
        provingAt: session.proveAt,
        head: session.head,
    };
    if (first) {
        note("First deposit on this account: register, setup and deposit go in one atomic action.");
        const allowance = await approvePool(session, config, amount * 2n, { dryRun: !confirmed });
        plan.allowance = allowance;
    }
    const result = await shield(session, config, amount, { first, dryRun: !confirmed });
    return ok(
        "shield",
        { ...plan, result },
        confirmed
            ? "Submitted. Poll balances until the note is indexed before shielding again."
            : "Dry run: proved server-side, nothing sent, no gas spent. Add --confirm to submit."
    );
}

/// Place a private bet on the parimutuel board.
///
/// This mints a bearer coupon and prints its private key exactly once. Whoever holds it owns the
/// payout, so an agent doing this is trading its own capital and must persist the coupon itself.
export async function bet({ config, args }) {
    const amount = requireAmount(args.amount, "--amount");
    const marketId = Number(args.market ?? 0);
    const outcome = Number(args.outcome ?? 0);
    const funding = requireFunding(args);
    const confirmed = isConfirmed(args);
    const coupon = newCoupon();
    const calldata = betCalldata({ marketId, outcome, amount, positionKey: coupon.positionKey });
    const session = await openSession(config, funding);
    const result = await poolBet(
        session,
        config,
        { calldata, amount, surplusTo: funding.address },
        { dryRun: !confirmed }
    );
    return ok(
        "bet",
        {
            marketId,
            outcome,
            amount,
            readable: `${formatStrk(amount)} STRK`,
            positionKey: coupon.positionKey,
            // Printed once and only to the caller that created it. Nothing else can collect this.
            couponPrivateKey: coupon.privateKey,
            calldata,
            result,
        },
        "SAVE couponPrivateKey now. It is the only thing that can collect this payout and it is not recoverable."
    );
}

/// Open a leveraged position, optionally granting a mandate in the same transaction.
///
/// Granting a mandate at open is the only time it can be set, which is deliberate: an authority that
/// could be widened later would be no bound at all. Pass --agent-key with at least one of --stop or
/// --take, plus --payout and the contract pins all of it.
export async function levOpen({ config, args }) {
    requireLeverage(config, "lev-open");
    const side = parseSide(args.side);
    const margin = requireAmount(args.margin, "--margin");
    const leverageBps = parseLeverage(args.leverage ?? "2x");
    const funding = requireFunding(args);
    const confirmed = isConfirmed(args);
    const market = await levMarketForArg(config, args.market);
    const quoted = quoteOpen(market, side, margin, leverageBps);
    // Guard the entry against the book moving: default to 2% of slip past the quote.
    const maxPriceBps = args["max-price"]
        ? Number(args["max-price"])
        : Math.min(10_000, quoted.priceAfterBps + 200);

    let granted = noMandate();
    if (args["agent-key"]) {
        // The agent key names WHO may act. A private key here would be the agent handing out its own
        // custody, so the same sound check applies: derive the public half and see if it owns a live
        // position on this market and side.
        await assertNotOwnerKey(
            String(args["agent-key"]),
            async (derived) => (await levPosition(config, market.id, side, derived)).state === "Open",
            "--agent-key"
        );
        granted = buildMandate({
            agentKey: String(args["agent-key"]),
            stopPriceBps: Number(args.stop ?? 0),
            takePriceBps: Number(args.take ?? 0),
            payoutTarget: String(args.payout ?? ""),
        });
    }

    const coupon = newCoupon();
    const calldata = openCalldata({
        marketId: market.id,
        side,
        positionKey: coupon.positionKey,
        margin,
        leverageBps,
        maxPriceBps,
        mandate: granted,
    });
    const session = await openSession(config, funding);
    const result = await poolOpen(
        session,
        config,
        { calldata, margin, surplusTo: funding.address },
        { dryRun: !confirmed }
    );
    return ok(
        "lev-open",
        {
            marketId: market.id,
            side,
            sideName: side === SIDE_YES ? "YES" : "NO",
            margin,
            leverageBps,
            maxPriceBps,
            quote: quoted,
            mandate: granted.agentKey === "0x0" ? null : granted,
            positionKey: coupon.positionKey,
            couponPrivateKey: coupon.privateKey,
            calldata,
            result,
        },
        "SAVE couponPrivateKey now: it is the only key that can close this position on your own terms. If you granted a mandate, the agent can only close inside the band, paying the address you pinned."
    );
}

/// Close a position on the owner's own terms, paying a public address.
///
/// Needs the coupon, which means this is the owner acting, not an agent. The coupon is read from a file
/// rather than an argument so a private key never lands in a shell history or a process list.
export async function levClose({ config, args }) {
    requireLeverage(config, "lev-close");
    const side = parseSide(args.side);
    const recipient = String(args.to ?? "");
    if (!recipient.startsWith("0x")) {
        return fail("lev-close", EXIT.badRequest, "BAD_RECIPIENT", "--to must be a Starknet address.", {
            hint: "The signature is bound to this address, so nobody can redirect the payout.",
        });
    }
    const couponPath = String(args.coupon ?? "");
    if (!couponPath || !existsSync(resolve(couponPath))) {
        return fail("lev-close", EXIT.badRequest, "NO_COUPON", `No coupon file at ${couponPath || "(unset)"}.`, {
            hint: "Pass --coupon <file> holding {privateKey, positionKey}. Never pass a private key as an argument.",
        });
    }
    const coupon = JSON.parse(readFileSync(resolve(couponPath), "utf8"));
    const market = await levMarketForArg(config, args.market);
    const funding = requireFunding(args);
    const confirmed = isConfirmed(args);
    const held = await levPosition(config, market.id, side, coupon.positionKey);
    if (held.state !== "Open") {
        return fail("lev-close", EXIT.refused, "NOT_OPEN", `That position is ${held.state}.`, {
            hint: "Only an open position can be closed.",
        });
    }
    const mark = markPosition(market, side, held);
    const calldata = closeToAddressCalldata({
        levAddress: config.leverage,
        marketId: market.id,
        side,
        privateKey: coupon.privateKey,
        positionKey: coupon.positionKey,
        recipient,
    });
    const session = await openSession(config, funding);
    const result = await poolInvoke(
        session,
        config,
        { contract: config.leverage, calldata, noteRecipient: funding.address },
        { dryRun: !confirmed }
    );
    return ok(
        "lev-close",
        {
            marketId: market.id,
            side,
            positionKey: coupon.positionKey,
            recipient,
            expectedEquity: mark.equity,
            readable: { equity: `${formatStrk(mark.equity)} STRK`, pnl: `${formatStrk(mark.pnl)} STRK` },
            result,
        },
        confirmed ? "Submitted." : "Dry run: proved, nothing sent. Add --confirm to submit."
    );
}

/// Fire a mandate this agent was granted.
///
/// The agent signs over the payout address the owner pinned at open, because that is the only message
/// the contract will verify. It names no target and no terms of its own: both are read from storage.
/// If the price is not in the band the contract refuses with MANDATE_NOT_MET, so this checks first and
/// reports that for free rather than spending gas to learn it.
export async function agentClose({ config, args }) {
    requireLeverage(config, "agent-close");
    const side = parseSide(args.side);
    const market = await levMarketForArg(config, args.market);
    const key = await requireKey(config, args.key, market.id, side);
    const own = readAgentKey(config);
    const granted = await levMandate(config, market.id, side, key);
    if (BigInt(granted.agentKey) === 0n) {
        return fail("agent-close", EXIT.refused, "NO_MANDATE", "That position is self-managed, so no agent may close it.", {
            hint: "Only the owner can close it. Ask them to or ask for a mandate at open next time.",
        });
    }
    if (BigInt(granted.agentKey) !== BigInt(own.publicKey)) {
        return fail(
            "agent-close",
            EXIT.refused,
            "NOT_MY_MANDATE",
            "That position is mandated to a different agent key.",
            { hint: "The contract verifies against the stored agent key, so this would revert. Do not retry." }
        );
    }
    const status = mandateStatus(market, side, granted);
    if (!status.firable) {
        return fail("agent-close", EXIT.refused, "MANDATE_NOT_MET", status.reason, {
            hint: `Live price is ${status.priceBps} bps. Stop fires at or below ${granted.stopPriceBps}, take at or above ${granted.takePriceBps}. Re-check later; scanning is free.`,
        });
    }
    const held = await levPosition(config, market.id, side, key);
    if (held.state !== "Open") {
        return fail("agent-close", EXIT.refused, "NOT_OPEN", `That position is ${held.state}.`);
    }
    const mark = markPosition(market, side, held);
    const funding = requireFunding(args);
    const confirmed = isConfirmed(args);
    const calldata = agentCloseCalldata({
        levAddress: config.leverage,
        marketId: market.id,
        side,
        positionKey: key,
        agentPrivateKey: own.privateKey,
        payoutTarget: granted.payoutTarget,
    });
    const session = await openSession(config, funding);
    const result = await poolInvoke(
        session,
        config,
        { contract: config.leverage, calldata, noteRecipient: funding.address },
        { dryRun: !confirmed }
    );
    return ok(
        "agent-close",
        {
            marketId: market.id,
            side,
            positionKey: key,
            firedOn: status.stopHit ? "stop" : "take",
            priceBps: status.priceBps,
            // Reported so the owner and any auditor can see the money went where they pinned it.
            paysPinnedTarget: granted.payoutTarget,
            expectedEquity: mark.equity,
            readable: { equity: `${formatStrk(mark.equity)} STRK` },
            calldata,
            result,
        },
        confirmed
            ? `Submitted. The payout goes to ${granted.payoutTarget}, which the owner pinned at open.`
            : "Dry run: proved, nothing sent. Add --confirm to fire it."
    );
}

/// Liquidate a position that has fallen to the maintenance floor, earning the keeper reward.
///
/// Permissionless and public: liquidation is infrastructure rather than a private trade, so it is an
/// ordinary transaction with no pool proof and no privacy. Anyone may send it, which is what keeps the
/// vault's loans recoverable.
export async function liquidate({ config, args }) {
    requireLeverage(config, "liquidate");
    const side = parseSide(args.side);
    const market = await levMarketForArg(config, args.market);
    const key = await requireKey(config, args.key, market.id, side);
    const held = await levPosition(config, market.id, side, key);
    if (held.state !== "Open") {
        return fail("liquidate", EXIT.refused, "NOT_OPEN", `That position is ${held.state}.`);
    }
    const mark = markPosition(market, side, held);
    if (!mark.liquidatable) {
        return fail(
            "liquidate",
            EXIT.refused,
            "HEALTHY",
            `Health is ${mark.healthBps} bps, above the ${config.risk.maintenanceMarginBps} floor.`,
            { hint: "The contract would refuse this. Re-scan later; scanning is free." }
        );
    }
    const reward = keeperReward(held, mark);
    const funding = requireFunding(args);
    const confirmed = isConfirmed(args);
    const call = {
        contractAddress: config.leverage,
        entrypoint: "liquidate",
        calldata: [String(market.id), String(side), key],
    };
    if (!confirmed) {
        return ok(
            "liquidate",
            { marketId: market.id, side, positionKey: key, healthBps: mark.healthBps, reward, call, submitted: false },
            `Dry run. Would earn about ${formatStrk(reward)} STRK. Add --confirm to send.`
        );
    }
    const { Account, RpcProvider } = await import("starknet");
    const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    const account = new Account({ provider, address: funding.address, signer: funding.privateKey, cairoVersion: "1" });
    const sent = await account.execute([call]);
    await provider.waitForTransaction(sent.transaction_hash, { retryInterval: 3000 });
    return ok(
        "liquidate",
        {
            marketId: market.id,
            side,
            positionKey: key,
            healthBps: mark.healthBps,
            reward,
            txHash: sent.transaction_hash,
            submitted: true,
        },
        `Liquidated. Keeper reward about ${formatStrk(reward)} STRK to ${funding.address}.`
    );
}
// PLACEHOLDER_LOOPS

/// The keeper loop: scan, liquidate what pays, repeat.
///
/// Liquidation is what makes the leverage engine actually safe rather than theoretically safe: a loan
/// is only recoverable while the position still has value, so somebody has to be watching. The reward
/// is what pays for that somebody and `--min-reward` keeps the loop from sending transactions that
/// cost more than they earn.
export async function keeper({ config, args }) {
    requireLeverage(config, "keeper");
    const minReward = args["min-reward"] ? requireAmount(args["min-reward"], "--min-reward") : 0n;
    const once = args.once === true || args.once === "true";
    const intervalMs = Number(args.interval ?? 60) * 1000;
    const confirmed = isConfirmed(args);
    const rounds = [];
    for (let round = 0; ; round += 1) {
        const scan = await scanKeeper(config, { minRewardWei: minReward });
        const acted = [];
        for (const candidate of scan.candidates) {
            if (!confirmed) {
                acted.push({ ...candidate, submitted: false, note: "dry run" });
                continue;
            }
            try {
                const result = await liquidate({
                    config,
                    args: {
                        market: candidate.marketId,
                        side: candidate.side,
                        key: candidate.positionKey,
                        confirm: true,
                        accounts: args.accounts,
                        account: args.account,
                    },
                });
                acted.push({ ...candidate, submitted: result.ok, txHash: result.data?.txHash, error: result.error });
            } catch (error) {
                // One failed liquidation must not stop the loop: another keeper may have taken it,
                // which is normal competition rather than a malfunction.
                acted.push({ ...candidate, submitted: false, error: String(error.message ?? error).slice(0, 200) });
            }
        }
        rounds.push({ round, scanned: scan.positionsScanned, liquidatable: scan.liquidatable, acted });
        note(`keeper round ${round}: ${scan.liquidatable} liquidatable of ${scan.positionsScanned} open`);
        if (once) break;
        await new Promise((done) => setTimeout(done, intervalMs));
    }
    return ok(
        "keeper",
        { minReward, confirmed, rounds },
        confirmed ? "Keeper ran and acted." : "Keeper ran in dry-run mode. Add --confirm to actually liquidate."
    );
}

/// The mandate watcher: scan the mandates this agent holds and fire each one whose band is met.
///
/// This is the agentic feature in its finished form. The owner is offline; the agent watches; when the
/// market reaches the price the owner named, the agent closes and the money goes to the owner's own
/// pinned address. The agent never had the power to do anything else.
export async function watch({ config, args }) {
    requireLeverage(config, "watch");
    const once = args.once === true || args.once === "true";
    const intervalMs = Number(args.interval ?? 60) * 1000;
    const confirmed = isConfirmed(args);
    const own = readAgentKey(config);
    const rounds = [];
    for (let round = 0; ; round += 1) {
        const scan = await scanMandates(config, own.publicKey);
        const acted = [];
        for (const entry of scan.mandates) {
            if (!entry.firable) continue;
            if (!confirmed) {
                acted.push({ ...entry, submitted: false, note: "dry run" });
                continue;
            }
            try {
                const result = await agentClose({
                    config,
                    args: {
                        market: entry.marketId,
                        side: entry.side,
                        key: entry.positionKey,
                        confirm: true,
                        accounts: args.accounts,
                        account: args.account,
                    },
                });
                acted.push({
                    ...entry,
                    submitted: result.ok,
                    txHash: result.data?.result?.txHash,
                    error: result.error,
                });
            } catch (error) {
                acted.push({ ...entry, submitted: false, error: String(error.message ?? error).slice(0, 200) });
            }
        }
        rounds.push({ round, held: scan.mandatesHeld, firable: scan.firable, acted });
        note(`watch round ${round}: ${scan.firable} firable of ${scan.mandatesHeld} held`);
        if (once) break;
        await new Promise((done) => setTimeout(done, intervalMs));
    }
    return ok(
        "watch",
        { agentKey: own.publicKey, confirmed, rounds },
        confirmed ? "Watcher ran and fired what it could." : "Watcher ran in dry-run mode. Add --confirm to fire mandates."
    );
}

/// Re-derive every recorded claim straight from chain, so nobody has to trust our README.
///
/// For each transaction: the receipt must say ACCEPTED and SUCCEEDED and the STRK20 pool must appear
/// in `events[].from_address`, which is the program's own eligibility test rather than a proxy for it.
/// For each contract: the class hash deployed at the address must match the one recorded. Exits
/// non-zero if any single claim fails, so it is usable as a gate rather than a report.
export async function verify({ config, args }) {
    const file = resolve(String(args.file ?? "strk20.json"));
    if (!existsSync(file)) {
        return fail("verify", EXIT.badRequest, "NO_FILE", `No file at ${file}.`, {
            hint: "Run this from the repo root or pass --file <path to strk20.json>.",
        });
    }
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    // The program's rule, applied exactly: a listed transaction must have succeeded, must have touched
    // the pool. If the submission lists contracts it must also carry an event from one of them.
    // Listing contracts therefore raises our own bar, so score against the list in the file rather than
    // against the one market address the config happens to know.
    const ourAddresses = (manifest.contracts ?? []).map((entry) => entry.address).filter(Boolean);
    // The hub reads only the first ten hashes and ignores the rest, so a qualifying transaction sitting
    // in slot eleven scores nothing. Mirror the window rather than checking everything and reporting a
    // total the hub will not agree with.
    const WINDOW = 10;
    const listed = manifest.transactions ?? [];
    const transactions = [];
    for (const txHash of listed.slice(0, WINDOW)) {
        try {
            const facts = await receiptFacts(config, txHash, ourAddresses);
            const needsOurs = ourAddresses.length > 0;
            const counts = countsUnderProgramRule(facts, needsOurs);
            transactions.push({
                txHash,
                ...facts,
                counts,
                verdict: counts ? "PASS" : "FAIL",
                why: !facts.succeeded
                    ? `execution status ${facts.execution}`
                    : !facts.poolEvent
                      ? "succeeded but no pool event, so it is not a pool transaction"
                      : counts
                        ? needsOurs
                            ? "succeeded, touched the pool and carried an event from a contract we list"
                            : "succeeded and the pool emitted an event in it"
                        : "touched the pool but carried no event from any contract we list, so it is the pool running rather than us",
            });
        } catch (error) {
            transactions.push({ txHash, counts: false, verdict: "FAIL", why: String(error.message ?? error).slice(0, 200) });
        }
    }
    const contracts = [];
    for (const entry of manifest.contracts ?? []) {
        try {
            const onChain = await classHashAt(config, entry.address);
            const matches = entry.class_hash ? BigInt(onChain) === BigInt(entry.class_hash) : true;
            contracts.push({
                name: entry.name,
                address: entry.address,
                recordedClassHash: entry.class_hash,
                onChainClassHash: onChain,
                verdict: matches ? "PASS" : "FAIL",
                why: matches ? "deployed class matches the recorded hash" : "deployed class differs from the record",
            });
        } catch (error) {
            contracts.push({
                name: entry.name,
                address: entry.address,
                verdict: "FAIL",
                why: String(error.message ?? error).slice(0, 200),
            });
        }
    }
    // Two different kinds of bad news, kept apart on purpose. A recorded transaction that reverted or
    // does not exist is a false claim in the file. One that succeeded but carries no event of ours is an
    // honest transaction that simply does not reach the program's bar, which is a shortfall rather than a
    // lie. Only the first kind, plus a contract whose class hash does not match, is dishonesty; the
    // shortfall gets its own message so a judge can tell them apart at a glance.
    const countable = transactions.filter((row) => row.counts);
    const untrue = transactions.filter((row) => row.verdict === "FAIL" && !row.succeeded);
    const poolOnly = transactions.filter((row) => row.succeeded && !row.counts);
    const badContracts = contracts.filter((row) => row.verdict !== "PASS");
    const REQUIRED = 3;
    const data = {
        file,
        network: config.network,
        pool: config.pool,
        rule: "a transaction counts when it succeeded, the pool emitted an event in it and a contract listed in this file emitted one too",
        transactions,
        contracts,
        summary: {
            transactionsListed: listed.length,
            transactionsChecked: transactions.length,
            beyondTheWindow: Math.max(0, listed.length - WINDOW),
            contractsChecked: contracts.length,
            countable: countable.length,
            required: REQUIRED,
            clearsTheBar: countable.length >= REQUIRED,
            poolOnly: poolOnly.length,
            notOnChainOrReverted: untrue.length,
            contractsMismatched: badContracts.length,
        },
    };
    if (untrue.length > 0 || badContracts.length > 0) {
        return {
            ok: false,
            command: "verify",
            code: EXIT.chainError,
            error: "VERIFICATION_FAILED",
            message: `${untrue.length + badContracts.length} recorded claim(s) do not hold against chain.`,
            data,
        };
    }
    if (countable.length < REQUIRED) {
        return {
            ok: false,
            command: "verify",
            code: EXIT.refused,
            error: "NOT_ENOUGH_COUNTABLE",
            message: `Every recorded claim holds, but only ${countable.length} of ${transactions.length} transaction(s) count under the program's rule and it asks for ${REQUIRED}.`,
            data,
            hint: "A transaction must carry an event from a contract listed in contracts[], not just a pool event. Route the action through our own contract.",
        };
    }
    return ok(
        "verify",
        data,
        `Every recorded transaction succeeded, ${countable.length} of ${transactions.length} carry both a pool event and an event from a contract we list. Every contract matches its recorded class hash. Verified against chain, not against our docs.`
    );
}
