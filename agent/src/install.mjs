/// Writing the skill and config files a host agent reads and detecting which host we are in.
///
/// One shape of truth, several renderings. `skills/capabilities.json` is the canonical machine-readable
/// description of what this runtime does; every host-specific file is generated from the same facts, so
/// a Claude Code skill, an openclaw tool manifest and a bare AGENTS.md can never disagree about what
/// the agent may do.
///
/// Host detection is a best guess from the environment and the filesystem and it is always overridable
/// with `--host`, because guessing wrong should be cheap to correct rather than something to debug.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

/// Which host agent this is, guessed from the environment then the filesystem.
///
/// Environment first because it is definitive when present: a host that sets its own variable is
/// telling us what it is. The filesystem is a weaker signal (a `.claude` directory may be a leftover),
/// so it only decides when nothing else does.
export function detectHost(cwd = process.cwd(), env = process.env) {
    if (env.CLAUDE_CODE || env.CLAUDECODE || env.CLAUDE_PROJECT_DIR) return "claude";
    if (env.OPENCLAW_HOME || env.OPENCLAW_CONFIG) return "openclaw";
    if (env.HERMES_HOME || env.HERMES_CONFIG) return "hermes";
    if (existsSync(join(cwd, ".claude"))) return "claude";
    if (existsSync(join(cwd, ".openclaw"))) return "openclaw";
    if (existsSync(join(cwd, ".hermes"))) return "hermes";
    return "generic";
}

/// Everything a host needs to know about this runtime, in one object.
///
/// This is the source every rendering is generated from. Read it directly if you are wiring a host that
/// has no dedicated renderer here: the commands, their arguments, the safety rules and the trust
/// boundary are all machine-readable, so an unknown agent can still self-orient.
export function capabilities({ agentPublicKey, config } = {}) {
    return {
        schema: "veilcast-agent/capabilities@1",
        name: "veilcast-agent",
        summary:
            "Trade and manage positions on Veilcast, a private prediction market on Starknet's STRK20 privacy pool, headlessly. Identity is private, amounts are public. An agent can hold a bounded mandate to close a position on an owner's behalf without ever being able to redirect the money.",
        network: config?.network ?? "mainnet",
        agentPublicKey: agentPublicKey ?? null,
        invocation: { command: "veilcast-agent", output: "one JSON object on stdout", progress: "stderr" },
        exitCodes: {
            0: "ok",
            2: "refused: a guard said no (band not met, position healthy). Retry later, do not escalate.",
            3: "not configured: something is missing. Run doctor and follow the fix.",
            4: "bad request: fix the arguments.",
            5: "chain or service error.",
            70: "internal error.",
        },
        safety: {
            dryRunByDefault:
                "Every money command is a dry run unless --confirm is passed. A dry run still proves the action server-side, so it validates for free and reports the real Cairo error.",
            protocol: [
                "Run the command without --confirm.",
                "Read the JSON and check the plan is what you intended.",
                "Re-run the identical command with --confirm only if it is.",
            ],
            neverDo: [
                "Never generate, request, store or accept an owner's position private key. The runtime refuses anything that looks like one.",
                "Never pass a private key as a command argument. Coupons are read from files.",
                "Never retry a command that failed with exit code 2 without re-checking the chain first: the answer was no, not maybe.",
                "Never substitute your own address for a mandate's payout target. The contract ignores it anyway.",
            ],
        },
        trustBoundary: {
            model:
                "A mandate is a bounded authority the position owner grants at open: an agent key, a stop and take price band and a payout address. All three are stored on-chain and checked by the contract on every agent close.",
            agentCan: [
                "read every market, price, position, mandate and the vault's solvency",
                "quote an entry or mark a position for free, with maths that matches the contract exactly",
                "close a position it holds a mandate for, once the live price is inside the granted band",
                "liquidate any position that has fallen to the 8% maintenance floor, earning the 1% keeper reward",
            ],
            agentCannot: [
                "redirect a payout: an agent close pays the address pinned at open, read from storage, never from the agent's input",
                "act outside its band: the contract compares the live marginal price to the stop and take",
                "widen its own mandate: a mandate is write-once at open and has no setter",
                "close a self-managed position: a zeroed agent key means no agent may ever act",
                "impersonate the owner: an owner signature and an agent signature verify against different keys, so neither can be replayed as the other",
            ],
            consequence:
                "A stolen agent key gets an attacker nothing but the ability to do what the owner already asked for, at a price the market actually reached, paying the owner's own address.",
        },
        privacy: {
            private: [
                "who opened or closed a position: the contract is never told an address and the on-chain sender is the pool's relayer",
                "the link between two positions by one person: every position is keyed by a fresh bearer coupon",
            ],
            public: [
                "every amount: margins, notionals, volumes and prices are all on-chain and readable",
                "liquidity provision and liquidation, which are infrastructure rather than trades",
            ],
            doNotClaim:
                "Never describe amounts as private. STRK20 gives identity privacy, not amount privacy and overclaiming it is wrong.",
        },
        commands: commandCatalog(),
    };
}

/// The command catalog: what each verb does, what it needs and whether it can spend.
function commandCatalog() {
    const read = (name, summary, args = []) => ({ name, summary, spends: false, args });
    const write = (name, summary, args = []) => ({
        name,
        summary,
        spends: true,
        dryRunDefault: true,
        args: [...args, "--confirm to actually send"],
    });
    return [
        read("status", "Endpoints, contracts, vault solvency and exactly what this agent can do. Run this first."),
        read("doctor", "Diagnose the setup and name the fix for anything broken."),
        read("agent-key", "Print this agent's public key, which an owner names in a mandate. Safe to share."),
        read("markets", "The live parimutuel board: questions, outcome volumes, implied probabilities and what a stake would pay. Works today with no deployment and no keys.", [
            "--stake <STRK> to quote the odds for a specific size",
        ]),
        read("flow", "One market's bet history from its event log: amounts and bearer keys, never addresses.", [
            "--market <id>",
        ]),
        read("lev-markets", "The leveraged board with live YES and NO prices."),
        read("vault", "Vault free collateral, backing, insurance and the solvency invariant."),
        read("position", "One position marked to the live book: equity, P&L, health.", [
            "--market <id>",
            "--side <yes|no>",
            "--key <positionPublicKey>",
        ]),
        read("mandate", "The authority a position carries, read from chain.", [
            "--market <id>",
            "--side <yes|no>",
            "--key <positionPublicKey>",
        ]),
        read("quote", "What an open would do, computed exactly as the contract does. Always quote first.", [
            "--market <id>",
            "--side <yes|no>",
            "--margin <STRK>",
            "--leverage <3x|30000>",
        ]),
        read("keeper-scan", "Positions liquidatable now, best paying first.", ["--min-reward <STRK>"]),
        read("mandate-scan", "Mandates this agent holds and which are firable right now."),
        read("verify", "Re-derive every claim in strk20.json straight from chain.", ["--file <path>"]),
        write("shield", "Move STRK into the privacy pool.", ["--amount <STRK>", "--first for a fresh account"]),
        write("lev-open", "Open a leveraged position, optionally granting a mandate.", [
            "--market <id>",
            "--side <yes|no>",
            "--margin <STRK>",
            "--leverage <3x>",
            "--agent-key <K> --stop <bps> --take <bps> --payout <addr> to grant a mandate",
        ]),
        write("lev-close", "Close a position on the owner's terms. Needs the coupon file.", [
            "--market <id>",
            "--side <yes|no>",
            "--coupon <file>",
            "--to <address>",
        ]),
        write("agent-close", "Fire a mandate granted to this agent.", [
            "--market <id>",
            "--side <yes|no>",
            "--key <positionPublicKey>",
        ]),
        write("liquidate", "Liquidate a position at the maintenance floor and earn the keeper reward.", [
            "--market <id>",
            "--side <yes|no>",
            "--key <positionPublicKey>",
        ]),
        write("keeper", "Scan and liquidate continuously.", ["--min-reward <STRK>", "--interval <sec>", "--once"]),
        write("watch", "Scan and fire mandates when a band is met.", ["--interval <sec>", "--once"]),
    ];
}
// PLACEHOLDER_INSTALL

/// Write the skill and config files the detected host reads and return what was written.
///
/// Idempotent: an existing file is left alone unless `force` is set, so re-running init never clobbers
/// a skill a user has edited. Every host gets AGENTS.md and capabilities.json too, because a host we
/// guessed wrong about can still read those.
export function writeSkills({ host = "auto", config, agentPublicKey, force = false, cwd = process.cwd() } = {}) {
    const resolved = host === "auto" ? detectHost(cwd) : host;
    const facts = capabilities({ agentPublicKey, config });
    const files = [];
    const put = (path, contents) => {
        const full = resolve(cwd, path);
        if (existsSync(full) && !force) {
            files.push({ path, written: false, reason: "already exists, left alone (use --force to overwrite)" });
            return;
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
        files.push({ path, written: true });
    };

    // Every host, whatever it is: the canonical machine-readable facts and a human-readable brief.
    put(".veilcast/capabilities.json", `${JSON.stringify(facts, null, 2)}\n`);
    put("AGENTS.md", renderAgentsMd(facts));

    if (resolved === "claude") {
        put(".claude/skills/veilcast/SKILL.md", renderClaudeSkill(facts));
    } else if (resolved === "openclaw") {
        put(".openclaw/tools/veilcast.json", `${JSON.stringify(renderOpenclawTool(facts), null, 2)}\n`);
        put(".openclaw/skills/veilcast.md", renderAgentsMd(facts));
    } else if (resolved === "hermes") {
        put(".hermes/skills/veilcast/manifest.json", `${JSON.stringify(renderHermesManifest(facts), null, 2)}\n`);
        put(".hermes/skills/veilcast/README.md", renderAgentsMd(facts));
    }
    return { host: resolved, files, capabilities: facts };
}

/// Read the packaged capabilities file if one was shipped, else compute it. Lets a consumer import the
/// facts without running init.
export function packagedCapabilities() {
    const packaged = join(PACKAGE_ROOT, "skills", "capabilities.json");
    if (existsSync(packaged)) return JSON.parse(readFileSync(packaged, "utf8"));
    return capabilities();
}

/// The host-neutral brief. Also used verbatim as the openclaw and Hermes skill body, because the
/// content an agent needs is the same; only the wrapper differs.
export function renderAgentsMd(facts) {
    const commandLines = facts.commands
        .map((command) => {
            const args = command.args.length > 0 ? ` ${command.args.join(" ")}` : "";
            const flag = command.spends ? " (spends, dry run by default)" : "";
            return `- \`veilcast-agent ${command.name}${args}\`${flag}\n  ${command.summary}`;
        })
        .join("\n");
    return `# Veilcast for agents

${facts.summary}

Network: ${facts.network}. Every command prints one JSON object on stdout; progress goes to stderr.

## Start here

\`\`\`bash
veilcast-agent status     # what you are pointed at and what you may do
veilcast-agent doctor     # if anything looks wrong, this names the fix
\`\`\`

## The money-safety protocol, every time

${facts.safety.dryRunByDefault}

${facts.safety.protocol.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## What you can and cannot do

You can:
${facts.trustBoundary.agentCan.map((line) => `- ${line}`).join("\n")}

You cannot do the following. The contract enforces it rather than convention:
${facts.trustBoundary.agentCannot.map((line) => `- ${line}`).join("\n")}

${facts.trustBoundary.consequence}

## Never do these

${facts.safety.neverDo.map((line) => `- ${line}`).join("\n")}

## Privacy, stated accurately

Private: ${facts.privacy.private.join("; ")}.

Public: ${facts.privacy.public.join("; ")}.

${facts.privacy.doNotClaim}

## Commands

${commandLines}

## Exit codes

${Object.entries(facts.exitCodes).map(([code, meaning]) => `- \`${code}\`: ${meaning}`).join("\n")}

## A worked example: run a keeper

\`\`\`bash
# 1. See what is liquidatable. Free, no keys needed.
veilcast-agent keeper-scan --min-reward 0.01

# 2. Dry run one liquidation and read the plan.
veilcast-agent liquidate --market 0 --side yes --key 0x<positionPublicKey>

# 3. Send it.
veilcast-agent liquidate --market 0 --side yes --key 0x<positionPublicKey> \\
  --accounts ./accounts.json --account keeper --confirm
\`\`\`

## A worked example: hold and fire a mandate

\`\`\`bash
# 1. Give the owner your public key. Safe to share: on its own it cannot move money.
veilcast-agent agent-key

# 2. The owner opens a position naming you, with a band and their own payout address.
#    You cannot do this step and you should not ask for the owner's coupon.

# 3. Watch for the band. Free.
veilcast-agent mandate-scan

# 4. Fire it when it is met. The payout goes to the owner's pinned address, not yours.
veilcast-agent agent-close --market 0 --side yes --key 0x<positionPublicKey> \\
  --accounts ./accounts.json --account agent --confirm
\`\`\`

Full manuals: \`docs/INTEGRATION.md\`, \`docs/OPERATIONS.md\`, \`docs/SECURITY.md\`.
`;
}

/// A Claude Code skill. The frontmatter is the contract with the host: `name` and `description` only,
/// and the description carries the trigger phrases, because that is what the host matches on.
export function renderClaudeSkill(facts) {
    return `---
name: veilcast
description: Trade and manage positions on Veilcast, a private prediction market on Starknet's STRK20 privacy pool, from the command line with no browser or wallet extension. Use when asked to check Veilcast markets or prices, quote or open a leveraged position, close or liquidate one, run a liquidation keeper, hold or fire an agent mandate (a stop or take-profit delegated by a position owner), check vault solvency or verify Veilcast's mainnet transactions. Triggers on veilcast, prediction market, STRK20, privacy pool, leveraged position, liquidation keeper, agent mandate, stop loss on chain, take profit on chain.
---

# Veilcast

${facts.summary}

Everything runs through one command, \`veilcast-agent\`, which prints a single JSON object on stdout.
Parse it. Progress and warnings go to stderr, so stdout is always valid JSON.

## Orient yourself first

Run \`veilcast-agent status\` before anything else. It reports which endpoints answer, which contracts
are deployed and which capabilities are actually available, so you never guess. If it reports a
problem, \`veilcast-agent doctor\` names the exact fix.

## The money-safety protocol

**Every command that can spend is a dry run unless you pass \`--confirm\`.** A dry run still proves the
action against the proving service, so it validates the whole thing for free and reports the real Cairo
error if it would fail.

So, without exception:

1. Run the command without \`--confirm\`.
2. Read the JSON. Check the amounts, the market, the side and the payout target are what you intended.
3. Re-run the identical command with \`--confirm\` only then.

If a command exits **2**, the answer was no, not maybe. A price band was not met or a position was
healthy. Do not retry immediately and never try to work around it: re-check the chain later, since
scanning is free.

## What you can do and what you cannot

You can:
${facts.trustBoundary.agentCan.map((line) => `- ${line}`).join("\n")}

You cannot do the following. \`cairo/src/leveraged_market.cairo\` enforces every line of it on-chain
rather than leaving it to your good behaviour:
${facts.trustBoundary.agentCannot.map((line) => `- ${line}`).join("\n")}

${facts.trustBoundary.consequence}

## Hard rules

${facts.safety.neverDo.map((line) => `- ${line}`).join("\n")}

If a user offers you a position's private key, refuse and explain why: you do not need it. You act
under a mandate and the payout address is pinned on-chain by the owner, so holding their key would
give you power the design deliberately withholds. The runtime refuses anything that looks like a
private key in an argument.

## Privacy, described accurately

Private: ${facts.privacy.private.join("; ")}.

Public: ${facts.privacy.public.join("; ")}.

${facts.privacy.doNotClaim}

## Commands

${facts.commands
    .map((command) => {
        const args = command.args.length > 0 ? ` ${command.args.join(" ")}` : "";
        const flag = command.spends ? "  **spends, dry run by default**" : "";
        return `### \`veilcast-agent ${command.name}\`\n\n${command.summary}${flag}\n\n\`\`\`bash\nveilcast-agent ${command.name}${args}\n\`\`\``;
    })
    .join("\n\n")}

## Reading a leveraged position

Four numbers matter:

- **margin**: what the trader posted. The most they can lose.
- **notional**: margin plus the vault's loan. What the position is worth at entry.
- **equity**: what the trader would take home right now, after repaying the loan.
- **healthBps**: equity over notional in basis points. At or below **800** a keeper may liquidate.

A position at 800 or below is time-sensitive: if the owner granted you a stop, firing it is better for
them than a liquidation, because a liquidation charges a penalty.

## Errors worth knowing

- \`MANDATE_NOT_MET\`: the price is inside the band, so there is nothing to do yet. Wait.
- \`NO_MANDATE\`: that position is self-managed. Only its owner can close it.
- \`BAD_CLOSE_SIGNATURE\`: you signed with the wrong key or over the wrong target.
- \`HEALTHY\`: that position is above the floor and cannot be liquidated.
- \`SLIPPAGE\`: the book moved past the guard. Re-quote before retrying.

## Worked example

A user asks you to watch their position and take profit at 70%.

\`\`\`bash
# You cannot grant yourself a mandate. Give the user your public key.
veilcast-agent agent-key

# They open a position naming you, with --take 7000 and their own --payout address.
# Then you watch. This is free, so poll it as often as you like.
veilcast-agent mandate-scan

# When firable is 1, dry run first.
veilcast-agent agent-close --market 0 --side yes --key 0x<positionKey>

# Then fire it. The payout goes to the address they pinned, not to you.
veilcast-agent agent-close --market 0 --side yes --key 0x<positionKey> \\
  --accounts ./accounts.json --account agent --confirm
\`\`\`
`;
}

/// An openclaw tool manifest. Flat verb list with typed parameters, which is what a tool-calling host
/// wants: no prose to parse and the safety rules attached to the tool rather than left to a prompt.
export function renderOpenclawTool(facts) {
    return {
        schema: "openclaw/tool@1",
        name: "veilcast",
        version: 1,
        summary: facts.summary,
        binary: "veilcast-agent",
        output: "json",
        network: facts.network,
        safety: {
            confirmFlag: "--confirm",
            dryRunByDefault: true,
            rule: facts.safety.dryRunByDefault,
            protocol: facts.safety.protocol,
            prohibited: facts.safety.neverDo,
        },
        trustBoundary: facts.trustBoundary,
        privacy: facts.privacy,
        exitCodes: facts.exitCodes,
        verbs: facts.commands.map((command) => ({
            verb: command.name,
            summary: command.summary,
            spends: command.spends,
            requiresConfirm: command.spends,
            parameters: command.args,
            invoke: `veilcast-agent ${command.name}`,
        })),
    };
}

/// A Hermes skill manifest. Same facts, Hermes's shape: entry point, capability list and the guardrails
/// as explicit policy rather than advice.
export function renderHermesManifest(facts) {
    return {
        schema: "hermes/skill@1",
        id: "veilcast",
        name: "Veilcast",
        description: facts.summary,
        entrypoint: { type: "cli", command: "veilcast-agent", output: "json", errors: "stderr" },
        network: facts.network,
        capabilities: facts.commands.map((command) => ({
            id: command.name,
            description: command.summary,
            mutating: command.spends,
            arguments: command.args,
        })),
        policy: {
            requireExplicitConfirmation: facts.commands.filter((command) => command.spends).map((command) => command.name),
            dryRunFirst: true,
            prohibited: facts.safety.neverDo,
            refusalCodes: { 2: facts.exitCodes[2] },
        },
        trustModel: facts.trustBoundary,
        privacyModel: facts.privacy,
        onboarding: [
            "veilcast-agent status",
            "veilcast-agent doctor",
            "veilcast-agent agent-key",
        ],
    };
}
