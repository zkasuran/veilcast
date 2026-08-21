import { ec, hash, num, shortString, stark } from "starknet";

/// Serde variant indices of `MarketAction` in the Cairo interface. The wallet takes raw felts, so
/// the calldata layout is written out by hand and has to match the enum.
const ACTION_BET = "0x0";
const ACTION_CLAIM = "0x1";
const TARGET_OPEN_NOTE = "0x0";
const TARGET_ADDRESS = "0x1";

/// Domain separator for the claim message, matching `CLAIM_MESSAGE_TAG` in the market contract.
const CLAIM_MESSAGE_TAG = shortString.encodeShortString("VEILCAST_CLAIM");

/// The wallet substitutes this with the id of the `n`th open note in the same STRK20 transaction.
export function openNotePlaceholder(index = 0): string {
    return `\${openNoteIds[${index}]}`;
}

/// A bet's proof of ownership, generated per bet and kept off-chain by the bettor.
///
/// The private key is what collects the payout; the public key is the position's on-chain owner and
/// the only handle the market ever sees. Two bets by one person share no key, so nothing on-chain
/// links them. Lose the coupon and the payout is gone; hold a copy and you can collect.
export type Coupon = {
    marketId: number;
    outcome: number;
    /// Stark private key. Keep it secret; it is the bearer of the position.
    privateKey: string;
    /// Stark public key, derived from the private key.
    positionKey: string;
    /// Staked amount in the token's smallest unit, as a decimal string.
    amount: string;
    createdAt: number;
};

/// Mints a fresh coupon for a bet. The private key is random and never derived from a wallet key, so
/// positions cannot be correlated through it.
export function newCoupon(marketId: number, outcome: number, amount: bigint): Coupon {
    const privateKey = stark.randomAddress();
    return {
        marketId,
        outcome,
        privateKey,
        positionKey: ec.starkCurve.getStarkKey(privateKey),
        amount: amount.toString(),
        createdAt: Date.now(),
    };
}

/// The message a coupon signs to release its payout, matching `claim_message_hash` in the contract.
/// `target` is zero for a payout into an open note, or the recipient address for a bound payout, so
/// a signature that names an address can never be redirected.
export function claimMessageHash(
    marketAddress: string,
    marketId: number,
    outcome: number,
    positionKey: string,
    target: string
): string {
    return hash.computePoseidonHashOnElements([
        CLAIM_MESSAGE_TAG,
        marketAddress,
        marketId,
        outcome,
        positionKey,
        target,
    ]);
}

/// Calldata for a bet: `[0, market_id, outcome, amount, position_key]`.
export function betCalldata(coupon: Coupon): string[] {
    return [
        ACTION_BET,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        num.toHex(BigInt(coupon.amount)),
        coupon.positionKey,
    ];
}

/// Calldata for a claim paid into the open note at `noteIndex` in this transaction:
/// `[1, market_id, outcome, position_key, r, s, 0, note_id]`. Signing a zero target is a bearer
/// authorization, good only for the note this transaction carries.
export function claimIntoNoteCalldata(coupon: Coupon, marketAddress: string, noteIndex = 0): string[] {
    const { r, s } = signClaim(coupon, marketAddress, "0x0");
    return [
        ACTION_CLAIM,
        num.toHex(coupon.marketId),
        num.toHex(coupon.outcome),
        coupon.positionKey,
        r,
        s,
        TARGET_OPEN_NOTE,
        openNotePlaceholder(noteIndex),
    ];
}

/// Calldata for a claim paid to `recipient`: `[1, market_id, outcome, position_key, r, s, 1,
/// recipient]`. The signature covers the recipient, so a copy can only ever pay the same address.
export function claimToAddressCalldata(coupon: Coupon, marketAddress: string, recipient: string): string[] {
    const { r, s } = signClaim(coupon, marketAddress, recipient);
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

function signClaim(coupon: Coupon, marketAddress: string, target: string): { r: string; s: string } {
    const messageHash = claimMessageHash(
        marketAddress,
        coupon.marketId,
        coupon.outcome,
        coupon.positionKey,
        target
    );
    const signature = ec.starkCurve.sign(messageHash, coupon.privateKey);
    return { r: num.toHex(signature.r), s: num.toHex(signature.s) };
}
