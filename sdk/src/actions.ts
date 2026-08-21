import type { WALLET_API } from "@starknet-io/types-js";
import { num } from "starknet";
import { type Coupon, betCalldata, claimIntoNoteCalldata, claimToAddressCalldata } from "./coupon.js";

/// The STRK20 action lists that drive Veilcast through the privacy pool.
///
/// A Veilcast action never goes to the market directly. The pool withdraws or creates notes and
/// invokes the market inside one atomic transaction, so the address the chain records is the pool's
/// relayer, never the bettor. These builders return the `actions` array you hand to
/// `walletAccount.strk20InvokeTransaction(actions)`.

/// The pool transaction that places a bet: withdraw the stake into the market, then invoke the
/// market to book it.
export function betActions(token: string, marketAddress: string, coupon: Coupon): WALLET_API.STRK20_ACTION[] {
    return [
        { type: "withdraw", token, amount: num.toHex(BigInt(coupon.amount)), recipient: marketAddress },
        { type: "invoke", contract: marketAddress, calldata: betCalldata(coupon) },
    ];
}

/// The pool transaction that collects several payouts at once, each into its own private note.
///
/// The order is load-bearing twice over: every open note has to be created before the invoke that
/// fills it, and each claim's `${openNoteIds[i]}` has to line up with the `i`th transfer. So it is a
/// run of open-note transfers, one per coupon, then a run of claim invokes, one per coupon.
export function batchClaimIntoNotesActions(
    token: string,
    marketAddress: string,
    coupons: Coupon[],
    noteRecipient: string
): WALLET_API.STRK20_ACTION[] {
    const opens: WALLET_API.STRK20_ACTION[] = coupons.map(() => ({
        type: "transfer",
        token,
        amount: "OPEN",
        recipient: noteRecipient,
    }));
    const claims: WALLET_API.STRK20_ACTION[] = coupons.map((coupon, index) => ({
        type: "invoke",
        contract: marketAddress,
        calldata: claimIntoNoteCalldata(coupon, marketAddress, index),
    }));
    return [...opens, ...claims];
}

/// The pool transaction that collects one payout as a private note. The one-coupon case of a batch.
export function claimIntoNoteActions(
    token: string,
    marketAddress: string,
    coupon: Coupon,
    noteRecipient: string
): WALLET_API.STRK20_ACTION[] {
    return batchClaimIntoNotesActions(token, marketAddress, [coupon], noteRecipient);
}

/// The pool transaction that collects one payout straight to a public address. This trades the
/// payout's privacy for a spendable balance; the coupon signature names the recipient, so nobody can
/// redirect it.
export function claimToWalletActions(marketAddress: string, coupon: Coupon, recipient: string): WALLET_API.STRK20_ACTION[] {
    return [
        { type: "invoke", contract: marketAddress, calldata: claimToAddressCalldata(coupon, marketAddress, recipient) },
    ];
}
