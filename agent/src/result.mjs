/// The result envelope every command returns and the exit codes that go with it.
///
/// An agent parses stdout as JSON, so the shape has to be predictable whether a command succeeded,
/// was refused or blew up. One object, always: `ok`, the `command`, a `data` payload on success or
/// an `error` on failure, plus `hint` telling the agent what to do next. No prose on stdout ever.

/// Exit codes. Distinct on purpose: an agent can branch on the number without parsing text.
export const EXIT = {
    ok: 0,
    /// The command ran and the answer is no: a guard refused it, a mandate was not met, a position
    /// was not liquidatable. Not a malfunction, so it is worth retrying later.
    refused: 2,
    /// The agent is not set up correctly: missing SDK path, no key, unreachable endpoint.
    notConfigured: 3,
    /// Bad arguments from the caller.
    badRequest: 4,
    /// The chain or a service rejected or failed the operation.
    chainError: 5,
    /// Anything unexpected.
    internal: 70,
};

/// A successful result. `hint` is for the agent, not the user: what this result means it may do next.
export function ok(command, data, hint) {
    return { ok: true, command, data, ...(hint ? { hint } : {}) };
}

/// A failure. `code` is one of EXIT, `error` is a stable machine-readable slug, `message` is one
/// human sentence and `hint` says how to fix it. `felt` carries a Cairo error string when the chain
/// gave one, because that is the single most useful thing for diagnosing a revert.
export function fail(command, code, error, message, { hint, felt, cause } = {}) {
    return {
        ok: false,
        command,
        code,
        error,
        message,
        ...(hint ? { hint } : {}),
        ...(felt ? { felt } : {}),
        ...(cause ? { cause: String(cause).slice(0, 400) } : {}),
    };
}

/// Print a result as JSON and exit with the code that matches it. The only writer to stdout.
export function emit(result) {
    process.stdout.write(`${JSON.stringify(result, replacer, 2)}\n`);
    process.exitCode = result.ok ? EXIT.ok : (result.code ?? EXIT.internal);
    return result;
}

/// Progress and warnings go to stderr, so stdout stays a single parseable JSON document.
export function note(message) {
    process.stderr.write(`${message}\n`);
}

/// BigInt is not JSON-serializable and amounts here are routinely bigint. Emit them as decimal
/// strings, which is lossless and what every caller wants.
function replacer(_key, value) {
    return typeof value === "bigint" ? value.toString() : value;
}

/// Pull a Cairo error string out of whatever a revert threw.
///
/// A reverted Starknet call reports its panic data as hex felts inside a long message. A Cairo
/// `assert` with a short-string reason shows up as an ASCII-decodable felt, so decoding the hex runs
/// in the message and keeping the ones that look like error codes recovers the actual reason. That
/// turns an unreadable wall of hex into `MANDATE_NOT_MET`, which an agent can act on.
export function feltError(error) {
    const message = String(error?.message ?? error ?? "");
    for (const match of message.matchAll(/0x[0-9a-fA-F]{8,}/g)) {
        const hex = match[0].slice(2);
        let ascii = "";
        for (let index = 0; index + 1 < hex.length; index += 2) {
            const code = Number.parseInt(hex.slice(index, index + 2), 16);
            if (code >= 32 && code < 127) ascii += String.fromCharCode(code);
            else ascii = "";
        }
        if (/^[A-Z][A-Z0-9_]{4,30}$/.test(ascii)) return ascii;
    }
    return undefined;
}

/// What each known Cairo error means and what the agent should do about it. Every entry is an error
/// the contracts or the pool actually raise; anything absent falls through to the raw felt.
export const FELT_HINTS = {
    UNAUTHORIZED_CALLER: "This entrypoint is pool-only. Route the action through the pool, not directly.",
    NO_MANDATE: "That position is self-managed. No agent may close it, so ask the owner to close it.",
    MANDATE_NOT_MET: "The price is inside the band you were granted only when the stop or take is reached. Wait and re-check.",
    BAD_CLOSE_SIGNATURE: "The signature did not verify against the key the contract expects. An agent must sign with its agent key over the pinned payout target.",
    ZERO_MANDATE_TARGET: "A mandate naming an agent must pin a payout address at open.",
    BAD_MANDATE: "A mandate must grant at least one of a stop or a take. An unconditional authority is refused.",
    POSITION_EXISTS: "That position key is already in use on this market and side. Mint a fresh key per position.",
    NO_POSITION: "No open position for that key. It may already be closed or liquidated.",
    HEALTHY: "That position is above the maintenance floor, so it cannot be liquidated yet.",
    SLIPPAGE: "The book moved past your price guard. Re-quote and raise maxPriceBps if the new price is acceptable.",
    INSUFFICIENT_VAULT: "The vault does not have enough free collateral to lend. Reduce leverage or add liquidity.",
    MARGIN_NOT_FUNDED: "The margin never arrived. The pool withdraw must land in the same transaction as the open.",
    BAD_LEVERAGE: "Leverage must be between 1x (10000) and 5x (50000) in basis points.",
    MARKET_CLOSED: "That market is past its close time and takes no new positions.",
    MARKET_SETTLED: "That market is already resolved or void.",
    PRIVATE_KEY_NOT_CANONICAL: "The viewing key must be poseidon([privateKey]) reduced mod n/2. Let the runtime derive it.",
    INDEX_NOT_SEQUENTIAL: "A prior note is not indexed yet. Poll discovery until it appears, then retry.",
    NO_REPLAY_PROTECTION: "That action needs a note operation alongside it. An invoke on its own is refused by the pool.",
    SUBCHANNEL_NOT_FOUND: "This account's pool state is partially set up. Use a fresh account with the atomic first deposit.",
};
