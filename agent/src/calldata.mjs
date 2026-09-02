/// Calldata builders and the close signature.
///
/// The pool takes raw felts, so every layout is written out by hand here and has to match the Cairo
/// enums in cairo/src/interface.cairo and cairo/src/leverage_interface.cairo. `test/calldata.test.mjs`
/// pins the close-message hash against the same felt the Cairo suite and the app assert, so a drift
/// in any layer fails a test rather than reverting a live transaction.

import { ec, hash, num, shortString, stark } from "starknet";

/// Serde variant indices of `MarketAction`.
const ACTION_BET = "0x0";
const ACTION_CLAIM = "0x1";
/// Serde variant indices of `LeverageAction`.
const LEV_OPEN = "0x0";
const LEV_CLOSE = "0x1";
const LEV_AGENT_CLOSE = "0x2";
/// Serde variant indices of `PayoutTarget`, shared by both contracts.
const TARGET_OPEN_NOTE = "0x0";
const TARGET_ADDRESS = "0x1";

/// Domain separators, matching CLAIM_MESSAGE_TAG in market.cairo and CLOSE_MESSAGE_TAG in
/// leverage_interface.cairo.
export const CLAIM_MESSAGE_TAG = shortString.encodeShortString("VEILCAST_CLAIM");
export const CLOSE_MESSAGE_TAG = shortString.encodeShortString("VEILCAST_LEVCLOSE");

export const SIDE_YES = 0;
export const SIDE_NO = 1;

/// Mint a fresh bearer coupon. The public half is the position's on-chain owner and the only handle
/// the contract ever sees, so two positions by one person share nothing on-chain.
///
/// An agent must never call this for someone else: whoever holds the private half owns the position
/// outright. It exists here so a self-driving trader (an agent trading its OWN capital) can open one.
export function newCoupon() {
    const privateKey = stark.randomAddress();
    return { privateKey, positionKey: ec.starkCurve.getStarkKey(privateKey) };
}

/// The message a coupon signs to release a market payout. `target` is zero for a payout into an open
/// note or the recipient address for a bound payout, so a signature naming an address can never be
/// redirected.
export function claimMessageHash(marketAddress, marketId, outcome, positionKey, target) {
    return hash.computePoseidonHashOnElements([
        CLAIM_MESSAGE_TAG,
        marketAddress,
        marketId,
        outcome,
        positionKey,
        target,
    ]);
}

/// The message a coupon signs to close a leveraged position and the same message an agent signs over
/// the mandate's pinned target. Identical bytes, different verifying key, which is what keeps the two
/// paths from being replayed as each other.
export function closeMessageHash(levAddress, marketId, side, positionKey, target) {
    return hash.computePoseidonHashOnElements([
        CLOSE_MESSAGE_TAG,
        levAddress,
        marketId,
        side,
        positionKey,
        target,
    ]);
}

/// Calldata for a bet: `[0, market_id, outcome, amount, position_key]`.
export function betCalldata({ marketId, outcome, amount, positionKey }) {
    return [ACTION_BET, num.toHex(marketId), num.toHex(outcome), num.toHex(amount), positionKey];
}

/// Calldata for a market claim paid into an open note created in the same transaction.
export function claimIntoNoteCalldata(coupon, marketAddress, noteId) {
    const { r, s } = signWith(coupon.privateKey, claimMessageHash(marketAddress, coupon.marketId, coupon.outcome, coupon.positionKey, "0x0"));
    return [
        ACTION_CLAIM,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        coupon.positionKey,
        r,
        s,
        TARGET_OPEN_NOTE,
        num.toHex(noteId),
    ];
}

/// Calldata for a market claim paid to a public address. The signature covers the recipient.
export function claimToAddressCalldata(coupon, marketAddress, recipient) {
    const { r, s } = signWith(coupon.privateKey, claimMessageHash(marketAddress, coupon.marketId, coupon.outcome, coupon.positionKey, recipient));
    return [
        ACTION_CLAIM,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        coupon.positionKey,
        r,
        s,
        TARGET_ADDRESS,
        num.toHex(recipient),
    ];
}

/// Calldata for a leveraged open, including the mandate:
/// `[0, market_id, side, position_key, margin, leverage_bps, max_price_bps,
///   agent_key, stop_price_bps, take_price_bps, payout_target]`.
///
/// Pass `noMandate()` for a self-managed position. A mandate naming an agent must pin a payout
/// address and grant at least one band or the contract refuses the open.
export function openCalldata({ marketId, side, positionKey, margin, leverageBps, maxPriceBps = 10_000, mandate = noMandate() }) {
    return [
        LEV_OPEN,
        num.toHex(marketId),
        num.toHex(side),
        positionKey,
        num.toHex(margin),
        num.toHex(leverageBps),
        num.toHex(maxPriceBps),
        mandate.agentKey,
        num.toHex(mandate.stopPriceBps),
        num.toHex(mandate.takePriceBps),
        num.toHex(mandate.payoutTarget),
    ];
}

/// A mandate that authorizes nobody, for a position its owner will manage itself.
export function noMandate() {
    return { agentKey: "0x0", stopPriceBps: 0, takePriceBps: 0, payoutTarget: "0x0" };
}

/// A mandate granting `agentKey` the right to close inside a band, paying only `payoutTarget`.
///
/// Both bands are basis points of probability: a stop fires at or below, a take at or above and zero
/// disables that half. The target is pinned here and read back from storage on every agent close, so
/// the agent can never redirect the money, which is the whole point.
export function mandate({ agentKey, stopPriceBps = 0, takePriceBps = 0, payoutTarget }) {
    if (!agentKey || BigInt(agentKey) === 0n) throw new Error("a mandate needs an agent key");
    if (!payoutTarget || BigInt(payoutTarget) === 0n) {
        throw new Error("a mandate must pin a payout address or the agent would have nowhere to pay");
    }
    if (stopPriceBps === 0 && takePriceBps === 0) {
        throw new Error("a mandate must grant a stop or a take; an unconditional authority is refused on-chain");
    }
    for (const [name, value] of [["stopPriceBps", stopPriceBps], ["takePriceBps", takePriceBps]]) {
        if (!Number.isInteger(value) || value < 0 || value > 10_000) {
            throw new Error(`${name} must be an integer in [0, 10000]`);
        }
    }
    return { agentKey, stopPriceBps, takePriceBps, payoutTarget };
}

/// Calldata for an owner close paid to an address:
/// `[1, market_id, side, position_key, r, s, 1, recipient]`.
export function closeToAddressCalldata({ levAddress, marketId, side, privateKey, positionKey, recipient }) {
    const { r, s } = signWith(privateKey, closeMessageHash(levAddress, marketId, side, positionKey, recipient));
    return [
        LEV_CLOSE,
        num.toHex(marketId),
        num.toHex(side),
        positionKey,
        r,
        s,
        TARGET_ADDRESS,
        num.toHex(recipient),
    ];
}

/// Calldata for an owner close paid into an open note created in the same transaction:
/// `[1, market_id, side, position_key, r, s, 0, note_id]`. A zero target is a bearer authorization,
/// good only for the note this transaction carries.
export function closeIntoNoteCalldata({ levAddress, marketId, side, privateKey, positionKey, noteId }) {
    const { r, s } = signWith(privateKey, closeMessageHash(levAddress, marketId, side, positionKey, "0x0"));
    return [
        LEV_CLOSE,
        num.toHex(marketId),
        num.toHex(side),
        positionKey,
        r,
        s,
        TARGET_OPEN_NOTE,
        num.toHex(noteId),
    ];
}

/// Calldata for an agent close: `[2, market_id, side, position_key, r, s]`.
///
/// Notice what is absent: no target and no terms. The contract reads the payout address and the band
/// from the stored mandate, so this input is only a request to act now. The agent signs over the
/// pinned target because that is the only message that will verify.
export function agentCloseCalldata({ levAddress, marketId, side, positionKey, agentPrivateKey, payoutTarget }) {
    const { r, s } = signWith(agentPrivateKey, closeMessageHash(levAddress, marketId, side, positionKey, payoutTarget));
    return [LEV_AGENT_CLOSE, num.toHex(marketId), num.toHex(side), positionKey, r, s];
}

/// Sign a message hash, returning hex felts.
export function signWith(privateKey, messageHash) {
    const signature = ec.starkCurve.sign(messageHash, privateKey);
    return { r: num.toHex(signature.r), s: num.toHex(signature.s) };
}
