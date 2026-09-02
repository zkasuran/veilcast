/// Key and state handling for an agent.
///
/// The security model in one line: **an agent never holds an owner key.** It holds its own signing
/// key, which is worth nothing on its own, because a mandate pins the payout address on-chain at
/// open and bounds the price at which the agent may act. So the worst case for a stolen agent key is
/// that someone else can fire a stop the owner already asked for, paying the owner's own address.
///
/// Three kinds of secret exist in this system and only one of them belongs here:
/// - the **agent key**, generated and stored by this module. Safe to hold.
/// - the **funding account key**, needed to pay gas and submit pool transactions. Read from an
///   sncast-style accounts file the operator points at. Never generated here, never copied.
/// - the **owner position key**, the bearer coupon that owns a position outright. An agent must
///   never generate, store or be handed one. `assertNotOwnerKey` exists so a caller that tries is
///   refused rather than quietly trusted.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ec, hash, stark } from "starknet";

/// File mode for anything holding a secret: owner read and write, nothing else.
const SECRET_MODE = 0o600;

/// Where the agent keeps its key and its notes, resolved from config.home.
export function paths(config) {
    const home = resolve(config.home);
    return {
        home,
        agentKey: join(home, "agent-key.json"),
        state: join(home, "state.json"),
    };
}

/// Generate the agent's signing key or return the existing one untouched.
///
/// Idempotent on purpose: `init` can be re-run safely and it will never silently replace a key that
/// positions in the wild have already been mandated to. Replacing one is an explicit `--rotate`,
/// which is a different operation with different consequences (every live mandate naming the old key
/// becomes unfireable and only the owner can then close).
export function ensureAgentKey(config, { rotate = false } = {}) {
    const { home, agentKey } = paths(config);
    if (existsSync(agentKey) && !rotate) {
        const existing = readAgentKey(config);
        return { ...existing, created: false };
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const privateKey = stark.randomAddress();
    const publicKey = ec.starkCurve.getStarkKey(privateKey);
    const record = { version: 1, privateKey, publicKey, createdAt: new Date().toISOString() };
    writeFileSync(agentKey, `${JSON.stringify(record, null, 2)}\n`, { mode: SECRET_MODE });
    chmodSync(agentKey, SECRET_MODE);
    return { ...record, created: true, path: agentKey };
}

/// Read the agent key, with a clear error when it is missing rather than a stack trace.
export function readAgentKey(config) {
    const { agentKey } = paths(config);
    if (!existsSync(agentKey)) {
        const error = new Error(`No agent key at ${agentKey}. Run: veilcast-agent init`);
        error.code = "NO_AGENT_KEY";
        throw error;
    }
    const record = JSON.parse(readFileSync(agentKey, "utf8"));
    return { ...record, path: agentKey, mode: modeOf(agentKey) };
}

/// The agent's public key, which is the only half that ever goes on-chain or into a mandate.
export function agentPublicKey(config) {
    return readAgentKey(config).publicKey;
}

/// Refuse a value that is provably an owner position private key.
///
/// An owner key and a position key are both Stark field elements, so **nothing about the bytes tells
/// them apart**. Guessing from shape is not possible and a guard that tried would reject the very
/// public keys these commands are meant to take. So the check here is a sound one instead of a
/// heuristic: derive the public half of the value and ask the chain whether THAT owns a position. If it
/// does, the caller handed over a private key, because only a private key has a public half that owns
/// something. If it does not, there is nothing to conclude and the value passes.
///
/// `lookup` is an async predicate the caller supplies, so this module stays free of chain access.
export async function assertNotOwnerKey(value, lookup, field = "--key") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value.trim())) return;
    let derived;
    try {
        derived = ec.starkCurve.getStarkKey(value.trim());
    } catch {
        // Not a valid scalar, so it cannot be a private key. Nothing to check.
        return;
    }
    if (BigInt(derived) === BigInt(value)) return;
    let ownsAPosition = false;
    try {
        ownsAPosition = await lookup(derived);
    } catch {
        // A failed lookup must not block a legitimate call; the contract is the real guard.
        return;
    }
    if (!ownsAPosition) return;
    const error = new Error(
        `${field} is an owner position PRIVATE key: its public half ${derived.slice(0, 14)}… owns a live position. An agent must never hold one. It signs with its own agent key and the payout address is pinned on-chain, so holding this would hand over custody the mandate design exists to withhold. Pass the public key instead.`
    );
    error.code = "OWNER_KEY_REFUSED";
    throw error;
}

/// Derive the canonical STRK20 viewing key for a funding account.
///
/// The pool rejects anything outside `[1, n/2)` with PRIVATE_KEY_NOT_CANONICAL, so the reduction is
/// mandatory rather than cosmetic: `poseidon([privateKey]) mod (n / 2)` and never zero. This is the
/// single most common way a headless integration fails, which is why it lives in one function.
export function viewingKey(privateKey) {
    const order = ec.starkCurve.CURVE.n;
    const max = order / 2n;
    const derived = BigInt(hash.computePoseidonHashOnElements([privateKey])) % max;
    return derived === 0n ? 1n : derived;
}

/// Load the funding account from an sncast-style accounts file.
///
/// The runtime reads it rather than owning it, so the operator keeps custody and the agent needs no
/// key of its own to pay gas. Only the named account is touched and the private key is never
/// written anywhere or echoed in output.
export function loadFundingAccount(accountsPath, accountName, network = "alpha-mainnet") {
    const path = resolve(accountsPath);
    if (!existsSync(path)) {
        const error = new Error(`No accounts file at ${path}`);
        error.code = "NO_ACCOUNTS_FILE";
        throw error;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const byNetwork = parsed[network] ?? parsed;
    const account = byNetwork?.[accountName];
    if (!account?.address || !account?.private_key) {
        const available = Object.keys(byNetwork ?? {}).join(", ") || "none";
        const error = new Error(
            `No account "${accountName}" in ${path} under ${network}. Available: ${available}`
        );
        error.code = "NO_SUCH_ACCOUNT";
        throw error;
    }
    return {
        address: account.address,
        privateKey: account.private_key,
        deployed: account.deployed !== false,
        mode: modeOf(path),
        path,
    };
}

/// Read the agent's local notebook: what it has seen, so a watcher does not re-quote from scratch.
/// Never holds a secret, so it is plain 0644 and safe to inspect.
export function readState(config) {
    const { state } = paths(config);
    if (!existsSync(state)) return { version: 1, mandates: [], seen: {} };
    try {
        return JSON.parse(readFileSync(state, "utf8"));
    } catch {
        // A corrupt notebook must not stop the agent working; it is a cache, not a source of truth.
        return { version: 1, mandates: [], seen: {} };
    }
}

export function writeState(config, state) {
    const { state: path } = paths(config);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return path;
}

/// The octal file mode of a path, for `doctor` to report a secret that is readable by others.
function modeOf(path) {
    try {
        return `0${(statSync(path).mode & 0o777).toString(8)}`;
    } catch {
        return undefined;
    }
}
