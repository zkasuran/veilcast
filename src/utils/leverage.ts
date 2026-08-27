"use client";

import { Contract, ec, hash, num, shortString, stark, type Abi, type Call, type ProviderInterface } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import leveragedMarketAbi from "@/abi/leveragedMarket.json";

/// Read and drive LeveragedMarket, the leveraged, isolated-margin companion to the parimutuel
/// Veilcast market. A position is long one side of a binary book (long NO is the short-YES trade),
/// priced by the same integer FPMM the contract settles against. Opening and closing route through
/// the STRK20 pool, so the trader is private; liquidity and liquidation are public infrastructure.
///
/// Everything on-chain here mirrors cairo/src/leveraged_market.cairo and cairo/src/pricing.cairo, so
/// a quote this file shows is the number the contract would compute, felt for felt.

const ABI = leveragedMarketAbi as Abi;

/// Serde variant indices of `LeverageAction` in cairo/src/leverage_interface.cairo.
const ACTION_OPEN = "0x0";
const ACTION_CLOSE = "0x1";
/// Serde variant indices of `PayoutTarget`, shared with the market.
const TARGET_OPEN_NOTE = "0x0";
const TARGET_ADDRESS = "0x1";
/// Matches CLOSE_MESSAGE_TAG in cairo/src/leverage_interface.cairo.
const CLOSE_MESSAGE_TAG = shortString.encodeShortString("VEILCAST_LEVCLOSE");

export const SIDE_YES = 0;
export const SIDE_NO = 1;
/// Leverage is basis points of 1x: 10000 is 1x, 50000 is the 5x cap.
export const LEVERAGE_ONE = 10_000;
export const MAX_LEVERAGE = 50_000;
/// Liquidate once equity falls to 8% of notional; a 0.30% open fee funds the insurance pool.
export const MAINTENANCE_MARGIN_BPS = 800;
export const OPEN_FEE_BPS = 30;
const BPS = 10_000n;

export type LevMarketState = "Open" | "Resolved" | "Void";
export type PositionState = "None" | "Open" | "Closed" | "Liquidated";

/// One leveraged market, decoded from `get_market`. Reserves price the book; everything is public.
export type LevMarketView = {
    id: number;
    resolver: string;
    closeAt: number;
    createdAt: number;
    rYes: bigint;
    rNo: bigint;
    state: LevMarketState;
    winningSide: number;
    liquidity: bigint;
    borrowedYes: bigint;
    borrowedNo: bigint;
};

/// A leveraged position, decoded from `get_position`.
export type LevPosition = {
    shares: bigint;
    margin: bigint;
    borrowed: bigint;
    state: PositionState;
};
/// A leveraged position's bearer proof, kept in this browser and nowhere else. The private key
/// closes the position and collects the equity; the public key is the only handle the contract
/// sees, so two positions by one person share nothing on-chain. Lose it and the margin is stranded.
export type LevCoupon = {
    marketId: number;
    side: number;
    /// Stark private key. Never leaves this browser.
    privateKey: string;
    positionKey: string;
    /// Trader collateral, the token's smallest unit, as a decimal string. The most it can lose.
    margin: string;
    leverageBps: number;
    createdAt: number;
    /// Transaction that opened the position, once the wallet has accepted it.
    openTx?: string;
    /// Transaction that closed it, once it has been closed.
    closeTx?: string;
};

const COUPON_STORAGE_KEY = "veilcast.leverage.coupons.v1";

/// Mints a fresh position coupon. The key is random, never derived from a wallet, so positions
/// cannot be correlated through it.
export function newLevCoupon(marketId: number, side: number, margin: bigint, leverageBps: number): LevCoupon {
    const privateKey = stark.randomAddress();
    return {
        marketId,
        side,
        privateKey,
        positionKey: ec.starkCurve.getStarkKey(privateKey),
        margin: margin.toString(),
        leverageBps,
        createdAt: Date.now(),
    };
}

export function loadLevCoupons(): LevCoupon[] {
    if (typeof window === "undefined") return [];
    try {
        const stored: unknown = JSON.parse(window.localStorage.getItem(COUPON_STORAGE_KEY) ?? "[]");
        return Array.isArray(stored) ? (stored as LevCoupon[]) : [];
    } catch {
        return [];
    }
}

export function saveLevCoupon(coupon: LevCoupon): LevCoupon[] {
    const coupons = [...loadLevCoupons(), coupon];
    writeLevCoupons(coupons);
    return coupons;
}

export function markLevOpened(positionKey: string, openTx: string): LevCoupon[] {
    return patchLevCoupon(positionKey, { openTx });
}

export function markLevClosed(positionKey: string, closeTx: string): LevCoupon[] {
    return patchLevCoupon(positionKey, { closeTx });
}

function patchLevCoupon(positionKey: string, patch: Partial<LevCoupon>): LevCoupon[] {
    const coupons = loadLevCoupons().map((c) => (c.positionKey === positionKey ? { ...c, ...patch } : c));
    writeLevCoupons(coupons);
    return coupons;
}

function writeLevCoupons(coupons: LevCoupon[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COUPON_STORAGE_KEY, JSON.stringify(coupons));
}

/// The message a coupon signs to close, matching `close_message_hash` in the contract: a zero
/// target for a payout into an open note, or the recipient for a bound payout, so a signature that
/// names an address can never be redirected.
export function closeMessageHash(
    levAddress: string,
    marketId: number,
    side: number,
    positionKey: string,
    target: string
): string {
    return hash.computePoseidonHashOnElements([CLOSE_MESSAGE_TAG, levAddress, marketId, side, positionKey, target]);
}

/// Calldata for an open: `[0, market_id, side, position_key, margin, leverage_bps, max_price_bps]`.
export function openCalldata(coupon: LevCoupon, maxPriceBps = 10_000): string[] {
    return [
        ACTION_OPEN,
        num.toHex(coupon.marketId),
        num.toHex(coupon.side),
        coupon.positionKey,
        num.toHex(BigInt(coupon.margin)),
        num.toHex(coupon.leverageBps),
        num.toHex(maxPriceBps),
    ];
}

/// Calldata for a close paid into the open note at `noteIndex`:
/// `[1, market_id, side, position_key, r, s, 0, note_id]`. A zero target is a bearer authorization,
/// good only for the note this transaction carries.
export function closeIntoNoteCalldata(coupon: LevCoupon, levAddress: string, noteIndex = 0): string[] {
    const { r, s } = signClose(coupon, levAddress, "0x0");
    return [
        ACTION_CLOSE,
        num.toHex(coupon.marketId),
        num.toHex(coupon.side),
        coupon.positionKey,
        r,
        s,
        TARGET_OPEN_NOTE,
        `\${openNoteIds[${noteIndex}]}`,
    ];
}

/// Calldata for a close paid to `recipient`: `[1, market_id, side, position_key, r, s, 1, recipient]`.
/// The signature covers the recipient, so a copy can only ever pay the same address.
export function closeToAddressCalldata(coupon: LevCoupon, levAddress: string, recipient: string): string[] {
    const { r, s } = signClose(coupon, levAddress, recipient);
    return [
        ACTION_CLOSE,
        num.toHex(coupon.marketId),
        num.toHex(coupon.side),
        coupon.positionKey,
        r,
        s,
        TARGET_ADDRESS,
        num.toHex(recipient),
    ];
}

function signClose(coupon: LevCoupon, levAddress: string, target: string): { r: string; s: string } {
    const messageHash = closeMessageHash(levAddress, coupon.marketId, coupon.side, coupon.positionKey, target);
    const signature = ec.starkCurve.sign(messageHash, coupon.privateKey);
    return { r: num.toHex(signature.r), s: num.toHex(signature.s) };
}
/// Floor integer square root, the bigint mirror of Cairo's `u256` sqrt. Used to quote a sell the
/// same way the contract computes it.
export function isqrt(n: bigint): bigint {
    if (n < 0n) throw new Error("isqrt of negative");
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

/// Marginal price of the `bought` outcome in basis points, `rOther / (rBought + rOther)` rounded
/// down. An empty book reads as an even 5000. Mirrors `pricing::price_bps`.
export function priceBps(rBought: bigint, rOther: bigint): number {
    const total = rBought + rOther;
    if (total === 0n) return 5000;
    return Number((rOther * BPS) / total);
}

/// Buy `amount` collateral worth of the `bought` outcome. Mirrors `pricing::buy`.
export function buy(
    rBought: bigint,
    rOther: bigint,
    amount: bigint
): { sharesOut: bigint; newBought: bigint; newOther: bigint } {
    const denom = rOther + amount;
    const numer = rBought * rOther;
    const ending = (numer + denom - 1n) / denom; // ceiling division
    return { sharesOut: rBought + amount - ending, newBought: ending, newOther: rOther + amount };
}

/// Sell `shares` of the `sold` outcome back to the pool. Mirrors `pricing::sell`.
export function sell(
    rSold: bigint,
    rOther: bigint,
    shares: bigint
): { amountOut: bigint; newSold: bigint; newOther: bigint } {
    const s = rSold + shares + rOther;
    const fourProd = 4n * shares * rOther;
    const disc = s * s - fourProd;
    const rootCeil = isqrt(disc) + 1n;
    const numer = s > rootCeil ? s - rootCeil : 0n;
    const x = numer / 2n;
    return { amountOut: x, newSold: rSold + shares - x, newOther: rOther - x };
}

/// The `(bought, other)` reserves for a side, so YES trades against NO and NO against YES.
export function sidesOf(market: LevMarketView, side: number): { rBought: bigint; rOther: bigint } {
    return side === SIDE_YES
        ? { rBought: market.rYes, rOther: market.rNo }
        : { rBought: market.rNo, rOther: market.rYes };
}

/// What opening `margin` at `leverageBps` on a side would do, computed exactly as `do_open`.
export type OpenQuote = {
    notional: bigint;
    borrowed: bigint;
    fee: bigint;
    invested: bigint;
    shares: bigint;
    entryPriceBps: number;
    priceAfterBps: number;
};

export function quoteOpen(market: LevMarketView, side: number, margin: bigint, leverageBps: number): OpenQuote {
    const notional = (margin * BigInt(leverageBps)) / BigInt(LEVERAGE_ONE);
    const borrowed = notional - margin;
    const fee = (notional * BigInt(OPEN_FEE_BPS)) / BPS;
    const invested = notional - fee;
    const { rBought, rOther } = sidesOf(market, side);
    const { sharesOut, newBought, newOther } = buy(rBought, rOther, invested);
    return {
        notional,
        borrowed,
        fee,
        invested,
        shares: sharesOut,
        entryPriceBps: priceBps(rBought, rOther),
        priceAfterBps: priceBps(newBought, newOther),
    };
}

/// A position marked to the live book, computed exactly as `position_equity`.
export type PositionMark = {
    value: bigint;
    equity: bigint;
    healthBps: number;
    pnl: bigint;
    liquidatable: boolean;
};

export function markPosition(market: LevMarketView, side: number, position: LevPosition): PositionMark {
    if (position.state !== "Open" || position.shares === 0n) {
        return { value: 0n, equity: 0n, healthBps: 0, pnl: 0n, liquidatable: false };
    }
    const { rBought, rOther } = sidesOf(market, side);
    const { amountOut: value } = sell(rBought, rOther, position.shares);
    const notional = position.margin + position.borrowed;
    const equity = value > position.borrowed ? value - position.borrowed : 0n;
    const healthBps = notional === 0n ? 0 : Number((equity * BPS) / notional);
    return { value, equity, healthBps, pnl: equity - position.margin, liquidatable: healthBps <= MAINTENANCE_MARGIN_BPS };
}
/// A LeveragedMarket bound to a provider for reads. Writes go through `populate` plus the wallet.
export function leveragedMarketContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: ABI, address, providerOrAccount: provider });
}

/// One leveraged market by id, or undefined if it does not exist.
export async function loadLevMarket(
    provider: ProviderInterface,
    address: string,
    marketId: number
): Promise<LevMarketView | undefined> {
    const contract = leveragedMarketContract(address, provider);
    const n = Number(await contract.call("get_n_markets", []));
    if (marketId >= n) return undefined;
    return decodeLevMarket(marketId, await contract.call("get_market", [marketId]));
}

/// Every leveraged market, newest first.
export async function loadLevBoard(provider: ProviderInterface, address: string): Promise<LevMarketView[]> {
    const contract = leveragedMarketContract(address, provider);
    const n = Number(await contract.call("get_n_markets", []));
    const views: LevMarketView[] = [];
    for (let id = n - 1; id >= 0; id -= 1) {
        views.push(decodeLevMarket(id, await contract.call("get_market", [id])));
    }
    return views;
}

/// A position by its coupon, decoded from `get_position`.
export async function loadPosition(
    provider: ProviderInterface,
    address: string,
    marketId: number,
    side: number,
    positionKey: string
): Promise<LevPosition> {
    return decodePosition(
        await leveragedMarketContract(address, provider).call("get_position", [marketId, side, positionKey])
    );
}

/// The vault's free collateral, its committed backing, and its insurance fund. With the contract's
/// token balance these are the solvency invariant the Cairo suite fuzzes.
export async function loadVault(
    provider: ProviderInterface,
    address: string
): Promise<{ free: bigint; backing: bigint; insurance: bigint }> {
    const contract = leveragedMarketContract(address, provider);
    const [free, backing, insurance] = await Promise.all([
        contract.call("get_vault_free", []),
        contract.call("get_total_backing", []),
        contract.call("get_insurance", []),
    ]);
    return { free: BigInt(free as bigint), backing: BigInt(backing as bigint), insurance: BigInt(insurance as bigint) };
}

/// Vault shares held by one liquidity provider.
export async function loadVaultShares(provider: ProviderInterface, address: string, lp: string): Promise<bigint> {
    return BigInt((await leveragedMarketContract(address, provider).call("get_vault_shares", [lp])) as bigint);
}

// ── Public calls (wallet.execute): liquidity and the market's public admin ──

export function addLiquidityCall(address: string, amount: bigint): Call {
    return leveragedMarketContract(address).populate("add_liquidity", [amount]);
}

export function removeLiquidityCall(address: string, lpShares: bigint): Call {
    return leveragedMarketContract(address).populate("remove_liquidity", [lpShares]);
}

export function createLevMarketCall(address: string, resolver: string, closeAt: number, liquidity: bigint): Call {
    return leveragedMarketContract(address).populate("create_market", [resolver, closeAt, liquidity]);
}

export function resolveLevCall(address: string, marketId: number, winningSide: number): Call {
    return leveragedMarketContract(address).populate("resolve", [marketId, winningSide]);
}

export function voidLevCall(address: string, marketId: number): Call {
    return leveragedMarketContract(address).populate("void", [marketId]);
}

export function liquidateCall(address: string, marketId: number, side: number, positionKey: string): Call {
    return leveragedMarketContract(address).populate("liquidate", [marketId, side, positionKey]);
}

// ── STRK20 action lists (wallet.strk20InvokeTransaction): the private trade ──

/// The pool transaction that opens a position: withdraw the margin into the contract, then invoke
/// the contract to book it. One atomic transaction, sender recorded as the pool.
export function openActions(
    token: string,
    levAddress: string,
    coupon: LevCoupon,
    maxPriceBps = 10_000
): WALLET_API.STRK20_ACTION[] {
    return [
        { type: "withdraw", token, amount: num.toHex(BigInt(coupon.margin)), recipient: levAddress },
        { type: "invoke", contract: levAddress, calldata: openCalldata(coupon, maxPriceBps) },
    ];
}

/// The pool transaction that closes a position to a private note. Only for a position that still
/// has equity to pay out; an underwater close pays nothing, so close it to an address instead.
export function closeIntoNoteActions(
    token: string,
    levAddress: string,
    coupon: LevCoupon,
    noteRecipient: string
): WALLET_API.STRK20_ACTION[] {
    return [
        { type: "transfer", token, amount: "OPEN", recipient: noteRecipient },
        { type: "invoke", contract: levAddress, calldata: closeIntoNoteCalldata(coupon, levAddress, 0) },
    ];
}

/// The pool transaction that closes a position straight to a public address. Trades the payout's
/// privacy for a spendable balance; the signature names the recipient, so nobody can redirect it.
export function closeToWalletActions(
    levAddress: string,
    coupon: LevCoupon,
    recipient: string
): WALLET_API.STRK20_ACTION[] {
    return [{ type: "invoke", contract: levAddress, calldata: closeToAddressCalldata(coupon, levAddress, recipient) }];
}

// ── Decoding ──

export function decodeLevMarket(id: number, raw: unknown): LevMarketView {
    const m = raw as {
        resolver: bigint;
        close_at: bigint;
        created_at: bigint;
        r_yes: bigint;
        r_no: bigint;
        state: unknown;
        winning_side: bigint;
        liquidity: bigint;
        borrowed_yes: bigint;
        borrowed_no: bigint;
    };
    return {
        id,
        resolver: num.toHex64(m.resolver),
        closeAt: Number(m.close_at),
        createdAt: Number(m.created_at),
        rYes: BigInt(m.r_yes),
        rNo: BigInt(m.r_no),
        state: decodeLevState(m.state),
        winningSide: Number(m.winning_side),
        liquidity: BigInt(m.liquidity),
        borrowedYes: BigInt(m.borrowed_yes),
        borrowedNo: BigInt(m.borrowed_no),
    };
}

export function decodePosition(raw: unknown): LevPosition {
    const p = raw as { shares: bigint; margin: bigint; borrowed: bigint; state: unknown };
    return {
        shares: BigInt(p.shares),
        margin: BigInt(p.margin),
        borrowed: BigInt(p.borrowed),
        state: decodePositionState(p.state),
    };
}

function decodeLevState(state: unknown): LevMarketState {
    const name = variantName(state, ["Open", "Resolved", "Void"]);
    return name === "Resolved" || name === "Void" ? name : "Open";
}

function decodePositionState(state: unknown): PositionState {
    const name = variantName(state, ["None", "Open", "Closed", "Liquidated"]);
    return name === "Open" || name === "Closed" || name === "Liquidated" ? name : "None";
}

/// Reads the active variant of a Cairo unit enum across the shapes starknet.js has parsed it into.
function variantName(state: unknown, order: string[]): string | undefined {
    if (typeof state === "string") return state;
    if (typeof state === "bigint" || typeof state === "number") return order[Number(state)];
    const custom = state as { activeVariant?: () => string } | undefined;
    if (typeof custom?.activeVariant === "function") return custom.activeVariant();
    const variant = (state as { variant?: Record<string, unknown> } | undefined)?.variant;
    return variant ? Object.entries(variant).find(([, value]) => value !== undefined)?.[0] : undefined;
}
