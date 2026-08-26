//! Types and ABI for the leveraged prediction market.
//!
//! A leveraged position is long one side of a binary market (long NO is the short-YES trade,
//! so two sides cover both directions). Collateral is the STRK smallest unit, shared with the
//! FPMM in `pricing`. Positions are opened and closed privately through the STRK20 pool via
//! `privacy_invoke` (pool-only, exactly like `VeilcastMarket`), keyed by a bearer
//! `position_key` that also doubles as the ECDSA public key authorizing the close. Liquidation
//! and liquidity provision are public, because they are infrastructure, not a private trade.

use starknet::ContractAddress;
use crate::interface::{OpenNoteDeposit, PayoutTarget};

pub const SIDE_YES: u8 = 0;
pub const SIDE_NO: u8 = 1;
/// Leverage is basis points of 1x: 10000 = 1x, 50000 = 5x (the hard cap).
pub const LEVERAGE_ONE: u32 = 10000;
pub const MAX_LEVERAGE: u32 = 50000;

/// Message tag for the close signature, mirroring VEILCAST_CLAIM in `market.cairo`.
pub const CLOSE_MESSAGE_TAG: felt252 = 'VEILCAST_LEVCLOSE';

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub enum PositionState {
    #[default]
    None,
    Open,
    Closed,
    Liquidated,
}

/// A leveraged position, keyed by `(market_id, side, position_key)`.
#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct Position {
    /// Outcome shares the position holds in the AMM.
    pub shares: u128,
    /// Trader collateral posted. The most the trader can lose (isolated margin).
    pub margin: u128,
    /// Collateral borrowed from the vault to reach the notional, owed back on close/liquidate.
    pub borrowed: u128,
    pub state: PositionState,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub enum LevMarketState {
    #[default]
    Open,
    Resolved,
    Void,
}

/// A leveraged market: an FPMM book over YES/NO shares plus the settlement metadata.
#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct LevMarket {
    /// Only address allowed to resolve. A resolver adapter (Pragma/committee) can hold this.
    pub resolver: ContractAddress,
    pub close_at: u64,
    pub created_at: u64,
    /// FPMM reserves (see `pricing`). Marginal YES price = r_no / (r_yes + r_no).
    pub r_yes: u128,
    pub r_no: u128,
    pub state: LevMarketState,
    /// Meaningful only when `Resolved`: the side that redeems at 1.
    pub winning_side: u8,
    /// Vault collateral committed as AMM liquidity for this market (returned to the vault at
    /// settlement). Lets the vault track per-market exposure.
    pub liquidity: u128,
    /// Sum of `borrowed` across this market's open positions, for the borrow cap and funding.
    pub borrowed_yes: u128,
    pub borrowed_no: u128,
}

/// Open a leveraged position long `side` of `market_id`, owned by `position_key`.
/// `margin` is the collateral the pool withdrew into this contract (checked against balance,
/// like a bet's STAKE_NOT_FUNDED). Notional = margin * leverage_bps / 10000.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct OpenInput {
    pub market_id: u64,
    pub side: u8,
    pub position_key: felt252,
    pub margin: u128,
    pub leverage_bps: u32,
    /// Slippage guard: the marginal price of `side` after the open must be <= this (bps).
    pub max_price_bps: u16,
}

/// Close the position `(market_id, side, position_key)`. Signature by `position_key` over
/// `close_message_hash`, target-bound exactly like a market claim.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct CloseInput {
    pub market_id: u64,
    pub side: u8,
    pub position_key: felt252,
    pub signature_r: felt252,
    pub signature_s: felt252,
    pub target: PayoutTarget,
}

/// The action the pool asks the leveraged market to perform, serialized variant-index-first:
/// - `Open`:  `[0, market_id, side, position_key, margin, leverage_bps, max_price_bps]`
/// - `Close`: `[1, market_id, side, position_key, r, s, target_variant, target_data]`
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub enum LeverageAction {
    Open: OpenInput,
    Close: CloseInput,
}

#[starknet::interface]
pub trait ILeveragedMarket<TState> {
    /// LPs add collateral (via ERC20 `transferFrom`) and receive vault shares. Returns shares.
    fn add_liquidity(ref self: TState, amount: u128) -> u128;
    /// Burn vault shares for a pro-rata slice of free (uncommitted) vault collateral.
    fn remove_liquidity(ref self: TState, lp_shares: u128) -> u128;

    /// Open a market. `liquidity` collateral is drawn from the vault to seed the FPMM at 50/50.
    fn create_market(
        ref self: TState, resolver: ContractAddress, close_at: u64, liquidity: u128,
    ) -> u64;
    /// Resolver-only, only after `close_at`. Pins `winning_side` (0/1); shares redeem 1 or 0.
    fn resolve(ref self: TState, market_id: u64, winning_side: u8);
    /// Cancel: every position reclaims its margin, the vault reclaims its liquidity.
    fn void(ref self: TState, market_id: u64);

    /// Permissionless: close an under-margined position, repay the vault, pay a keeper reward.
    fn liquidate(ref self: TState, market_id: u64, side: u8, position_key: felt252);

    /// Open or close a leveraged position. Pool-only, driven by the STRK20 privacy_invoke path.
    fn privacy_invoke(ref self: TState, action: LeverageAction) -> Span<OpenNoteDeposit>;

    fn get_market(self: @TState, market_id: u64) -> LevMarket;
    fn get_position(self: @TState, market_id: u64, side: u8, position_key: felt252) -> Position;
    /// Marginal price of `side` in basis points.
    fn price_bps(self: @TState, market_id: u64, side: u8) -> u16;
    /// `(value, equity, health_bps)`; `health = equity * 10000 / notional`. A position with
    /// `health_bps <= MAINTENANCE_MARGIN_BPS` is liquidatable.
    fn position_equity(
        self: @TState, market_id: u64, side: u8, position_key: felt252,
    ) -> (u128, u128, u16);
    fn get_n_markets(self: @TState) -> u64;
    fn get_total_backing(self: @TState) -> u128;
    fn get_vault_free(self: @TState) -> u128;
    fn get_vault_shares(self: @TState, lp: ContractAddress) -> u128;
    fn get_insurance(self: @TState) -> u128;
    fn get_pool(self: @TState) -> ContractAddress;
    fn get_token(self: @TState) -> ContractAddress;
}

pub mod errors {
    pub const UNAUTHORIZED_CALLER: felt252 = 'UNAUTHORIZED_CALLER';
    pub const NOT_RESOLVER: felt252 = 'NOT_RESOLVER';
    pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
    pub const ZERO_POSITION_KEY: felt252 = 'ZERO_POSITION_KEY';
    pub const ZERO_POOL: felt252 = 'ZERO_POOL';
    pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
    pub const ZERO_RESOLVER: felt252 = 'ZERO_RESOLVER';
    pub const BAD_SIDE: felt252 = 'BAD_SIDE';
    pub const BAD_LEVERAGE: felt252 = 'BAD_LEVERAGE';
    pub const CLOSE_IN_PAST: felt252 = 'CLOSE_IN_PAST';
    pub const NO_MARKET: felt252 = 'NO_MARKET';
    pub const MARKET_CLOSED: felt252 = 'MARKET_CLOSED';
    pub const MARKET_NOT_CLOSED: felt252 = 'MARKET_NOT_CLOSED';
    pub const MARKET_SETTLED: felt252 = 'MARKET_SETTLED';
    pub const MARKET_UNSETTLED: felt252 = 'MARKET_UNSETTLED';
    pub const SLIPPAGE: felt252 = 'SLIPPAGE';
    pub const INSUFFICIENT_VAULT: felt252 = 'INSUFFICIENT_VAULT';
    pub const MARGIN_NOT_FUNDED: felt252 = 'MARGIN_NOT_FUNDED';
    pub const POSITION_EXISTS: felt252 = 'POSITION_EXISTS';
    pub const NO_POSITION: felt252 = 'NO_POSITION';
    pub const HEALTHY: felt252 = 'HEALTHY';
    pub const BAD_CLOSE_SIGNATURE: felt252 = 'BAD_CLOSE_SIGNATURE';
    pub const ZERO_RECIPIENT: felt252 = 'ZERO_RECIPIENT';
    pub const OVERFLOW: felt252 = 'OVERFLOW';
}
