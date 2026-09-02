/// A Model Context Protocol server, so a web coding host can drive and watch Veilcast without leaving
/// the editor.
///
/// Why MCP rather than another skill file: the skills in `install.mjs` teach a host that runs shell
/// commands. A browser host (claude.ai, an IDE panel, a hosted agent) has no shell, so a skill telling
/// it to type `veilcast-agent vault` is useless there. MCP is the interface those hosts already speak,
/// and it is the only one that carries typed tool schemas plus a transport they can reach.
///
/// Two facts shape the design:
///
///   - **There is nothing to push into.** A browser host polls; it cannot receive a webhook. So alerts
///     are *derived on demand* from the current block rather than queued, which also means an alert can
///     never be stale or duplicated. `alerts` is the tool a host calls on a timer.
///   - **Money must stay hard to spend by accident.** Every write tool is dry-run unless `confirm` is
///     true, exactly as the CLI is. The schema says so in the field description, so a model reads it
///     before filling it in.
///
/// Implemented by hand against the JSON-RPC 2.0 wire format rather than with an SDK, because the runtime
/// has exactly one dependency and that property is worth more than the few hundred lines saved.

import { capabilities, commandCatalog } from "./install.mjs";
import * as commands from "./commands.mjs";
import { EXIT } from "./result.mjs";

/// Protocol versions this server will accept, newest first.
///
/// A host sends the version it wants in `initialize`. The spec says to answer with a version both sides
/// support, so this negotiates rather than asserting: refusing a host over a date string would break an
/// integration that would otherwise work fine.
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const SERVER_INFO = { name: "veilcast", version: "0.2.0" };

/// The arguments every tool understands, described once.
///
/// `confirm` appears only on tools that spend. Its description is load-bearing: a model reads it and
/// learns that omitting it is safe, which is the behaviour we want by default.
const CONFIRM_FIELD = {
    type: "boolean",
    description:
        "Send the transaction. Omit or set false to dry run, which still proves the action server-side and reports the real Cairo error for free. Never set this without the user having seen the dry run.",
};

/// The tools this server exposes, with a JSON Schema per tool.
///
/// Generated from the same catalog the skill files are generated from, so a browser host and a shell
/// host can never be told a different set of verbs. Only the argument shapes are hand-written, because a
/// CLI flag list is not a schema: `--market <id>` says nothing about whether the id is a number.
const ARGS = {
    markets: { stake: { type: "string", description: "Quote the odds for this stake, in STRK (e.g. \"10\")." } },
    flow: { market: { type: "integer", description: "Market id." } },
    "vault-lp": { lp: { type: "string", description: "The liquidity provider's Starknet address." } },
    alerts: {
        lp: { type: "string", description: "Also check this address's liquidity position." },
        "min-reward": { type: "string", description: "Ignore keeper work paying less than this, in STRK." },
    },
    position: {
        market: { type: "integer", description: "Market id." },
        side: { type: "string", enum: ["yes", "no"], description: "Which side of the book." },
        key: { type: "string", description: "The position's PUBLIC key. Never a private key." },
    },
    mandate: {
        market: { type: "integer", description: "Market id." },
        side: { type: "string", enum: ["yes", "no"] },
        key: { type: "string", description: "The position's PUBLIC key." },
    },
    quote: {
        market: { type: "integer" },
        side: { type: "string", enum: ["yes", "no"] },
        margin: { type: "string", description: "Margin to post, in STRK." },
        leverage: { type: "string", description: "Leverage as \"3x\", \"3\" or basis points." },
    },
    "keeper-scan": { "min-reward": { type: "string", description: "Skip candidates paying less, in STRK." } },
    verify: { file: { type: "string", description: "Path to a strk20.json. Defaults to the working directory's." } },
    shield: {
        amount: { type: "string", description: "STRK to move into the privacy pool." },
        first: { type: "boolean", description: "This account's first deposit, which registers and sets up atomically." },
        confirm: CONFIRM_FIELD,
    },
    bet: {
        market: { type: "integer" },
        outcome: { type: "integer", description: "Outcome index, from the markets tool." },
        amount: { type: "string", description: "Stake in STRK." },
        confirm: CONFIRM_FIELD,
    },
    "lev-open": {
        market: { type: "integer" },
        side: { type: "string", enum: ["yes", "no"] },
        margin: { type: "string" },
        leverage: { type: "string" },
        "agent-key": { type: "string", description: "Grant a mandate to this agent public key." },
        stop: { type: "integer", description: "Stop price in basis points, required with agent-key." },
        take: { type: "integer", description: "Take price in basis points, required with agent-key." },
        payout: { type: "string", description: "Where an agent close pays. Written to storage, unchangeable after." },
        confirm: CONFIRM_FIELD,
    },
    "agent-close": {
        market: { type: "integer" },
        side: { type: "string", enum: ["yes", "no"] },
        key: { type: "string", description: "The position's PUBLIC key." },
        confirm: CONFIRM_FIELD,
    },
    liquidate: {
        market: { type: "integer" },
        side: { type: "string", enum: ["yes", "no"] },
        key: { type: "string" },
        confirm: CONFIRM_FIELD,
    },
    "lp-add": {
        amount: { type: "string", description: "Collateral to provide, in STRK." },
        confirm: CONFIRM_FIELD,
    },
    "lp-remove": {
        shares: { type: "string", description: "Vault shares to burn. Not STRK: read vault-lp first." },
        confirm: CONFIRM_FIELD,
    },
    "lev-create": {
        liquidity: { type: "string", description: "AMM depth drawn from free vault collateral, in STRK." },
        days: { type: "number", description: "Days until the market closes. Defaults to 7." },
        resolver: { type: "string", description: "Who settles it. Defaults to the funding account." },
        confirm: CONFIRM_FIELD,
    },
    "lev-resolve": {
        market: { type: "integer" },
        side: { type: "string", enum: ["yes", "no"], description: "The winning side." },
        confirm: CONFIRM_FIELD,
    },
    "lev-void": {
        market: { type: "integer" },
        confirm: CONFIRM_FIELD,
    },
    "resolve-market": {
        market: { type: "integer" },
        outcome: { type: "integer", description: "Index of the winning outcome, from the markets tool." },
        confirm: CONFIRM_FIELD,
    },
    "void-market": { market: { type: "integer" }, confirm: CONFIRM_FIELD },
    "collect-fee": { market: { type: "integer" }, confirm: CONFIRM_FIELD },
};

/// Verbs deliberately withheld from MCP, with the reason.
///
/// A tool list is a menu. A menu with an item that cannot work is worse than a shorter menu. These
/// either need a local filesystem, run forever or take a bearer secret that must not cross a tool
/// boundary into a hosted model's context.
const WITHHELD = {
    init: "writes skill files to a local filesystem, which a browser host does not have",
    keeper: "runs forever; call keeper-scan then liquidate instead",
    watch: "runs forever; call alerts then agent-close instead",
    "lev-close": "needs the owner's bearer coupon, which must never pass through a hosted model's context",
};

export function toolList() {
    const tools = [];
    for (const verb of commandCatalog()) {
        if (WITHHELD[verb.name]) continue;
        const properties = ARGS[verb.name] ?? {};
        tools.push({
            name: verb.name.replace(/-/g, "_"),
            description: verb.spends
                ? `${verb.summary} SPENDS MONEY: dry run unless confirm is true.`
                : `${verb.summary} Free, read-only.`,
            inputSchema: { type: "object", properties, required: REQUIRED[verb.name] ?? [] },
        });
    }
    return tools;
}

/// Which arguments a verb cannot run without, declared rather than derived.
///
/// Deriving this from the catalog's flag strings was tried and abandoned: the notation does not encode
/// optionality soundly. `--min-reward <STRK>` and `--file <path>` look identical to `--market <id>` yet
/// both default, while `--stake <STRK> to quote a specific size` only reads as optional from its prose.
/// A wrong `required` is worse than a hand-written one, because a model refuses to call a tool it thinks
/// it cannot satisfy. So it lives beside the schema it belongs to. A test asserts every name here
/// exists in that schema and that `confirm` never appears.
const REQUIRED = {
    flow: ["market"],
    "vault-lp": ["lp"],
    position: ["market", "side", "key"],
    mandate: ["market", "side", "key"],
    quote: ["market", "side", "margin", "leverage"],
    shield: ["amount"],
    bet: ["market", "outcome", "amount"],
    "lev-open": ["market", "side", "margin", "leverage"],
    "agent-close": ["market", "side", "key"],
    liquidate: ["market", "side", "key"],
    "lp-add": ["amount"],
    "lp-remove": ["shares"],
    "lev-create": ["liquidity"],
    "lev-resolve": ["market", "side"],
    "lev-void": ["market"],
    "resolve-market": ["market", "outcome"],
    "void-market": ["market"],
    "collect-fee": ["market"],
};


/// Resources: the documents a host can read once and keep, rather than re-deriving from tool calls.
///
/// A model that has read the trust boundary will not propose a plan the contract would refuse, which
/// saves a round trip and a confusing revert. These are static, so they cost nothing to serve.
export function resourceList() {
    return [
        {
            uri: "veilcast://capabilities",
            name: "What this agent can and cannot do",
            description:
                "The machine-readable capability manifest: every verb, the exit codes, the safety model and the five things the contract makes an agent structurally unable to do.",
            mimeType: "application/json",
        },
        {
            uri: "veilcast://privacy",
            name: "What is private and what is not",
            description:
                "STRK20 gives identity privacy, not amount privacy. Read this before describing the system to a user, because overclaiming is the common mistake.",
            mimeType: "text/markdown",
        },
    ];
}

const PRIVACY_DOC = `# What Veilcast keeps private

STRK20 gives **identity privacy, not amount privacy.** Never tell a user their amounts are hidden.

## Private

- Who opened, closed or bet. The contract is never told an address; the on-chain sender is the pool's
  relayer.
- The link between two positions held by one person, because every position is keyed by a fresh bearer
  coupon rather than by an owner.

## Public

- Every amount. Margins, notionals, stakes, volumes, prices, the vault's whole state.
- Liquidity provision and liquidation, which are infrastructure rather than anyone's trade.

Amounts are public on purpose: a prediction market with hidden sizes cannot produce accurate odds, and
the odds are the product.
`;

export function readResource(uri, { config, agentPublicKey } = {}) {
    if (uri === "veilcast://capabilities") {
        return {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(capabilities({ config, agentPublicKey }), null, 2),
        };
    }
    if (uri === "veilcast://privacy") {
        return { uri, mimeType: "text/markdown", text: PRIVACY_DOC };
    }
    const error = new Error(`No resource at ${uri}`);
    error.code = "NO_SUCH_RESOURCE";
    throw error;
}

/// Handle one JSON-RPC request and return the response object, else null for a notification.
///
/// Pure apart from the tool calls themselves, so the whole protocol surface is testable without a
/// transport. A notification (no `id`) gets no response, which the spec requires and which a host will
/// hang on if you get it wrong.
export async function handle(request, { config, agentPublicKey, run = callTool } = {}) {
    const { id, method, params } = request ?? {};
    const isNotification = id === undefined || id === null;
    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const error = (code, message, data) =>
        isNotification ? null : { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };

    try {
        if (method === "initialize") {
            const wanted = params?.protocolVersion;
            return reply({
                // Answer with the version the host asked for when we speak it, rather than always the
                // newest: a host that pinned an older date is telling us what it can parse.
                protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
                capabilities: { tools: {}, resources: {} },
                serverInfo: SERVER_INFO,
                instructions:
                    "Veilcast: a private, leveraged prediction market on Starknet. Read veilcast://privacy before describing it to a user, because STRK20 gives identity privacy and not amount privacy. Every tool that spends is a dry run unless confirm is true. A dry run still proves the action for free. Call alerts on a timer to see what needs attention.",
            });
        }
        if (method === "notifications/initialized" || method === "ping") {
            return method === "ping" ? reply({}) : null;
        }
        if (method === "tools/list") return reply({ tools: toolList() });
        if (method === "resources/list") return reply({ resources: resourceList() });
        if (method === "resources/read") {
            return reply({ contents: [readResource(params?.uri, { config, agentPublicKey })] });
        }
        if (method === "tools/call") {
            const name = String(params?.name ?? "");
            const verb = name.replace(/_/g, "-");
            if (!toolList().some((tool) => tool.name === name)) {
                return error(-32602, `No such tool: ${name}`, {
                    withheld: WITHHELD[verb] ?? undefined,
                    available: toolList().map((tool) => tool.name),
                });
            }
            const result = await run(verb, params?.arguments ?? {}, { config });
            // MCP reports a tool that ran and refused as content with isError, not as a protocol error:
            // the call itself succeeded. The model needs to read why the answer was no.
            return reply({
                content: [{ type: "text", text: JSON.stringify(result, bigintSafe, 2) }],
                isError: result.ok === false,
            });
        }
        return error(-32601, `Method not found: ${method}`);
    } catch (thrown) {
        return error(-32603, String(thrown?.message ?? thrown).slice(0, 400), { code: thrown?.code });
    }
}

/// Run one verb through the same command functions the CLI uses.
///
/// Deliberately the same functions rather than a re-implementation: a browser host and a shell host must
/// not be able to get different answers. Arguments arrive as JSON so they are already typed, in the same
/// shape the CLI's parser produces.
export async function callTool(verb, args, { config }) {
    const handler = HANDLERS[verb];
    if (!handler) {
        const error = new Error(`No handler for ${verb}`);
        error.code = "NO_HANDLER";
        throw error;
    }
    try {
        return await handler({ config, args, command: verb });
    } catch (thrown) {
        // A thrown command becomes a normal failure envelope, because a model reading `error` and `hint`
        // recovers better than one reading a stack trace.
        return {
            ok: false,
            command: verb,
            code: thrown?.code === "LEVERAGE_NOT_DEPLOYED" ? EXIT.notConfigured : EXIT.chainError,
            error: thrown?.code ?? "FAILED",
            message: String(thrown?.message ?? thrown).slice(0, 400),
        };
    }
}

const HANDLERS = {
    status: commands.status,
    doctor: commands.doctor,
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
};

/// bigint is not JSON-serializable and every amount here is one. Decimal strings are lossless.
function bigintSafe(_key, value) {
    return typeof value === "bigint" ? value.toString() : value;
}
