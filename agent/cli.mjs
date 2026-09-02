#!/usr/bin/env node
/// veilcast-agent: drive Veilcast from an autonomous agent.
///
/// Every command prints one JSON object to stdout and nothing else, so an LLM parses it instead of
/// scraping prose. Progress goes to stderr. Exit codes are stable: 0 ok, 2 refused, 3 not configured,
/// 4 bad request, 5 chain error, 70 internal.
///
/// Every command that could spend money is a DRY RUN unless `--confirm` is passed. A dry run still
/// proves the action server-side, so it catches a bad request for free and reports the real Cairo
/// error. The safety protocol for an agent is therefore: run it, read the JSON, then re-run with
/// --confirm only if the plan is what you intended.

import { EXIT, emit, fail, feltError, note, FELT_HINTS } from "./src/result.mjs";
import { configFrom } from "./src/config.mjs";
import * as commands from "./src/commands.mjs";

const USAGE = `veilcast-agent <command> [options]

Read-only, free, no keys needed:
  status                    endpoints, contracts, vault solvency, what this agent can do
  doctor                    diagnose the setup and name the exact fix for anything broken
  markets    [--stake STRK]  the live parimutuel board: questions, odds and what a stake pays
  flow       --market <id>   that market's bet history, read from its own event log
  lev-markets               the leveraged board with live prices
  vault                     vault free, backing, insurance, share price and the solvency invariant
  vault-lp --lp ADDR        one LP's shares, their worth, what a withdrawal pays and the P&L
  alerts     [--lp ADDR]     everything needing attention right now, most severe first
  position   --market --side --key       one leveraged position, marked to the book
  mandate    --market --side --key       the authority a position carries
  quote      --market --side --margin --leverage   what an open would do, exactly as the contract
  keeper-scan  [--min-reward STRK]       positions liquidatable now, best paying first
  mandate-scan                            mandates this agent holds and which are firable
  verify     [--file strk20.json]        re-derive every recorded claim straight from chain

Setup:
  init       [--host auto|claude|openclaw|hermes|generic] [--rotate]
  mcp                       serve MCP on stdio, for a web host that has no shell
  agent-key                 print this agent's PUBLIC key, for an owner to put in a mandate

Money (dry run by default, add --confirm to send):
  shield     --amount STRK [--first]     move STRK into the pool
  bet        --market --outcome --amount
  lev-open   --market --side --margin --leverage [--max-price BPS]
             [--agent-key K --stop BPS --take BPS --payout ADDR]
  lev-close  --market --side --coupon FILE --to ADDR
  agent-close --market --side --key      fire a mandate granted to this agent
  liquidate  --market --side --key       liquidate a position at the maintenance floor
  lp-add     --amount STRK               provide vault collateral and receive shares
  lp-remove  --shares N                  burn shares for a slice of free collateral
  lev-create --liquidity STRK [--days N] open a leveraged market, seeded from the vault
  lev-resolve --market --side            settle a market on its winning side (resolver only)
  lev-void   --market                    cancel a market, refunding every margin (resolver only)
  resolve-market --market --outcome      settle a parimutuel market (resolver only, after close)
  void-market --market                   refund every stake (resolver; anyone 30d after close)
  collect-fee --market                   sweep a resolved market's fee to its fixed recipient
  keeper     [--min-reward STRK] [--once]  scan and liquidate, continuously
  watch      [--interval SEC] [--once]     scan and fire mandates when a band is met

Common options:
  --accounts PATH --account NAME   the funding account that pays gas (sncast accounts file)
  --sdk PATH                       a built STRK20 privacy SDK (or VEILCAST_PRIVACY_SDK)
  --leverage-address ADDR          LeveragedMarket contract override (--leverage is the multiple)
  --market ADDR                    VeilcastMarket contract override, when it starts with 0x
  --rpc URL                        Starknet RPC override
  --json                           (default) machine-readable output
  --confirm                        actually send; without it nothing is submitted

Full docs: docs/INTEGRATION.md, docs/OPERATIONS.md, docs/SECURITY.md`;

/// Parse `--flag value` and `--flag` pairs into an object. Unknown flags are kept rather than
/// rejected, so a host that passes extra context does not break the call.
function parseArgs(argv) {
    const args = { _: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            args._.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            index += 1;
        }
    }
    return args;
}

/// Map the flags an agent passes onto the config overrides the runtime understands.
///
/// Two flags are deliberately overloaded, because both readings are natural and an agent will use
/// both: `--market` is a market id on most commands and a contract address on none of them unless it
/// starts with `0x` and `--leverage` is a leverage multiple (`3x`) on the trading commands while
/// `--leverage-address` names the contract. So an address override is only taken when it looks like an
/// address, which keeps `quote --leverage 3x` from silently pointing the runtime at a contract called
/// "3x".
const HANDLERS = {
    status: commands.status,
    doctor: commands.doctor,
    init: commands.init,
    "agent-key": commands.agentKeyCommand,
    markets: commands.markets,
    flow: commands.flow,
    "lev-markets": commands.levMarkets,
    vault: commands.vault,
    "vault-lp": commands.vaultLp,
    alerts: commands.alerts,
    position: commands.position,
    mandate: commands.mandateCommand,
    quote: commands.quote,
    "keeper-scan": commands.keeperScan,
    "mandate-scan": commands.mandateScan,
    verify: commands.verify,
    shield: commands.shieldCommand,
    bet: commands.bet,
    "lev-open": commands.levOpen,
    "lev-close": commands.levClose,
    "agent-close": commands.agentClose,
    liquidate: commands.liquidate,
    "lp-add": commands.lpAdd,
    "lp-remove": commands.lpRemove,
    "lev-create": commands.levCreate,
    "lev-resolve": commands.levResolve,
    "lev-void": commands.levVoid,
    "resolve-market": commands.resolveMarket,
    "void-market": commands.voidMarket,
    "collect-fee": commands.collectFee,
    keeper: commands.keeper,
    watch: commands.watch,
};

async function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    if (!command || command === "help" || command === "--help" || command === "-h") {
        note(USAGE);
        process.exitCode = command ? EXIT.ok : EXIT.badRequest;
        return;
    }
    // Not in HANDLERS: the server holds the process open and speaks JSON-RPC on stdout, where every other
    // verb prints one envelope and exits. Routing it through the same table would corrupt the stream.
    if (command === "mcp") {
        const { serve } = await import("./src/mcp-stdio.mjs");
        await serve({ argv: argv.slice(1) });
        return;
    }
    const handler = HANDLERS[command];
    if (!handler) {
        emit(
            fail(command, EXIT.badRequest, "UNKNOWN_COMMAND", `No such command: ${command}`, {
                hint: "Run veilcast-agent help for the command list.",
            })
        );
        return;
    }
    const args = parseArgs(argv.slice(1));
    const config = configFrom(args);
    try {
        emit(await handler({ config, args, command }));
    } catch (error) {
        const felt = feltError(error);
        const code =
            error.code === "NO_PRIVACY_SDK" ||
            error.code === "PRIVACY_SDK_UNLOADABLE" ||
            error.code === "NO_AGENT_KEY" ||
            error.code === "NO_ACCOUNTS_FILE" ||
            error.code === "NO_SUCH_ACCOUNT" ||
            // A contract that is not deployed on this network is a setting to fix, not a chain fault.
            // Reporting it as a chain error would tell an agent to retry something that cannot succeed.
            error.code === "LEVERAGE_NOT_DEPLOYED"
                ? EXIT.notConfigured
                : error.code === "OWNER_KEY_REFUSED" || error.code === "NO_LP_ADDRESS"
                  ? EXIT.badRequest
                  : felt
                    ? EXIT.refused
                    : EXIT.chainError;
        emit(
            fail(command, code, error.code ?? felt ?? "FAILED", error.message ?? String(error), {
                felt,
                hint: felt ? FELT_HINTS[felt] : undefined,
            })
        );
    }
}

await main();
