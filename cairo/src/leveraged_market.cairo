//! LeveragedMarket: private, leveraged directional positions on a binary prediction market.
//!
//! Design that keeps it solvent (see docs): each market is an FPMM (`pricing`) whose reserves
//! are backed one-for-one by STRK held here (complete-set model: 1 STRK mints 1 YES + 1 NO, and
//! only the winning side ever redeems, so the contract itself can never be drained). Leverage
//! is a *vault* risk, not a contract-solvency risk: a trader posts `margin`, the vault lends
//! `borrowed` to reach the notional, and positions are marked and settled against the live AMM
//! price. A keeper liquidates a position the moment its equity falls to the maintenance floor,
//! so the vault's loan is recovered before it can go bad; any residual gap is absorbed by an
//! insurance fund. Opening and closing route through the STRK20 pool (`privacy_invoke`,
//! pool-only), so the trader's identity is private; amounts are public (STRK20 model).

use starknet::ContractAddress;

#[starknet::interface]
pub trait IErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod LeveragedMarket {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use crate::interface::{OpenNoteDeposit, PayoutTarget};
    use crate::leverage_interface::{
        CLOSE_MESSAGE_TAG, CloseInput, LEVERAGE_ONE, LevMarket, LevMarketState, LeverageAction,
        MAX_LEVERAGE, OpenInput, Position, PositionState, SIDE_NO, SIDE_YES, errors,
    };
    use crate::pricing;
    use super::{IErc20Dispatcher, IErc20DispatcherTrait};

    // Risk parameters (basis points of notional unless noted).
    const MAINTENANCE_MARGIN_BPS: u16 = 800; // liquidate when equity/notional <= 8%
    const LIQUIDATION_PENALTY_BPS: u128 = 200; // 2% of notional, split keeper/insurance
    const KEEPER_REWARD_BPS: u128 = 100; // 1% of notional to the liquidator
    const OPEN_FEE_BPS: u128 = 30; // 0.30% of notional to insurance
    const BPS: u128 = 10000;

    #[storage]
    struct Storage {
        pool: ContractAddress,
        token: ContractAddress,
        n_markets: u64,
        /// Total vault net worth in STRK (free + committed as market liquidity + lent as
        /// borrowed + accrued fees - realized losses). LP shares are priced against this.
        vault_capital: u128,
        /// Uncommitted STRK the vault can lend or seed right now; caps LP withdrawals.
        vault_free: u128,
        vault_shares_total: u128,
        vault_shares: Map<ContractAddress, u128>,
        /// STRK committed across all markets' AMMs (complete-set backing). With vault_free and
        /// insurance it accounts for every token the contract holds: balance >= vault_free +
        /// total_backing + insurance, always (the leveraged analogue of VeilcastMarket's escrow).
        total_backing: u128,
        insurance: u128,
        markets: Map<u64, LevMarket>,
        positions: Map<(u64, u8, felt252), Position>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        LiquidityAdded: LiquidityAdded,
        LiquidityRemoved: LiquidityRemoved,
        MarketCreated: MarketCreated,
        PositionOpened: PositionOpened,
        PositionClosed: PositionClosed,
        PositionLiquidated: PositionLiquidated,
        MarketResolved: MarketResolved,
        MarketVoided: MarketVoided,
    }

    #[derive(Drop, starknet::Event)]
    struct LiquidityAdded {
        lp: ContractAddress,
        amount: u128,
        shares: u128,
    }
    #[derive(Drop, starknet::Event)]
    struct LiquidityRemoved {
        lp: ContractAddress,
        shares: u128,
        amount: u128,
    }
    #[derive(Drop, starknet::Event)]
    struct MarketCreated {
        market_id: u64,
        resolver: ContractAddress,
        close_at: u64,
        liquidity: u128,
    }
    #[derive(Drop, starknet::Event)]
    struct PositionOpened {
        market_id: u64,
        side: u8,
        position_key: felt252,
        margin: u128,
        notional: u128,
        shares: u128,
    }
    #[derive(Drop, starknet::Event)]
    struct PositionClosed {
        market_id: u64,
        side: u8,
        position_key: felt252,
        payout: u128,
    }
    #[derive(Drop, starknet::Event)]
    struct PositionLiquidated {
        market_id: u64,
        side: u8,
        position_key: felt252,
        keeper: ContractAddress,
        bad_debt: u128,
    }
    #[derive(Drop, starknet::Event)]
    struct MarketResolved {
        market_id: u64,
        winning_side: u8,
    }
    #[derive(Drop, starknet::Event)]
    struct MarketVoided {
        market_id: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool: ContractAddress, token: ContractAddress) {
        assert(pool.is_non_zero(), errors::ZERO_POOL);
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
        self.pool.write(pool);
        self.token.write(token);
    }

    #[abi(embed_v0)]
    impl LeveragedMarketImpl of crate::leverage_interface::ILeveragedMarket<ContractState> {
        fn add_liquidity(ref self: ContractState, amount: u128) -> u128 {
            assert(amount != 0, errors::ZERO_AMOUNT);
            let caller = get_caller_address();
            self.erc20().transfer_from(caller, get_contract_address(), amount.into());
            let total = self.vault_shares_total.read();
            let capital = self.vault_capital.read();
            let shares = if total == 0 {
                amount
            } else {
                mul_div(amount, total, capital)
            };
            self.vault_capital.write(capital + amount);
            self.vault_free.write(self.vault_free.read() + amount);
            self.vault_shares_total.write(total + shares);
            self.vault_shares.write(caller, self.vault_shares.read(caller) + shares);
            self.emit(LiquidityAdded { lp: caller, amount, shares });
            shares
        }

        fn remove_liquidity(ref self: ContractState, lp_shares: u128) -> u128 {
            assert(lp_shares != 0, errors::ZERO_AMOUNT);
            let caller = get_caller_address();
            let owned = self.vault_shares.read(caller);
            assert(owned >= lp_shares, errors::INSUFFICIENT_VAULT);
            let total = self.vault_shares_total.read();
            let capital = self.vault_capital.read();
            let amount = mul_div(lp_shares, capital, total);
            let free = self.vault_free.read();
            assert(free >= amount, errors::INSUFFICIENT_VAULT);
            self.vault_shares.write(caller, owned - lp_shares);
            self.vault_shares_total.write(total - lp_shares);
            self.vault_capital.write(capital - amount);
            self.vault_free.write(free - amount);
            self.erc20().transfer(caller, amount.into());
            self.emit(LiquidityRemoved { lp: caller, shares: lp_shares, amount });
            amount
        }

        fn create_market(
            ref self: ContractState, resolver: ContractAddress, close_at: u64, liquidity: u128,
        ) -> u64 {
            assert(resolver.is_non_zero(), errors::ZERO_RESOLVER);
            assert(close_at > get_block_timestamp(), errors::CLOSE_IN_PAST);
            assert(liquidity != 0, errors::ZERO_AMOUNT);
            let free = self.vault_free.read();
            assert(free >= liquidity, errors::INSUFFICIENT_VAULT);
            self.vault_free.write(free - liquidity); // committed to the AMM, still vault_capital
            // The seed STRK now backs this market's complete sets: keep the balance invariant
            // (balance == vault_free + total_backing + insurance) tight.
            self.total_backing.write(self.total_backing.read() + liquidity);
            let id = self.n_markets.read();
            self
                .markets
                .write(
                    id,
                    LevMarket {
                        resolver,
                        close_at,
                        created_at: get_block_timestamp(),
                        r_yes: liquidity,
                        r_no: liquidity,
                        state: LevMarketState::Open,
                        winning_side: SIDE_YES,
                        liquidity,
                        borrowed_yes: 0,
                        borrowed_no: 0,
                    },
                );
            self.n_markets.write(id + 1);
            self.emit(MarketCreated { market_id: id, resolver, close_at, liquidity });
            id
        }

        fn resolve(ref self: ContractState, market_id: u64, winning_side: u8) {
            let mut m = self.market(market_id);
            assert(get_caller_address() == m.resolver, errors::NOT_RESOLVER);
            assert(m.state == LevMarketState::Open, errors::MARKET_SETTLED);
            assert(get_block_timestamp() >= m.close_at, errors::MARKET_NOT_CLOSED);
            assert(winning_side == SIDE_YES || winning_side == SIDE_NO, errors::BAD_SIDE);
            m.state = LevMarketState::Resolved;
            m.winning_side = winning_side;
            self.markets.write(market_id, m);
            self.emit(MarketResolved { market_id, winning_side });
        }

        fn void(ref self: ContractState, market_id: u64) {
            let mut m = self.market(market_id);
            assert(get_caller_address() == m.resolver, errors::NOT_RESOLVER);
            assert(m.state == LevMarketState::Open, errors::MARKET_SETTLED);
            m.state = LevMarketState::Void;
            self.markets.write(market_id, m);
            self.emit(MarketVoided { market_id });
        }

        fn liquidate(ref self: ContractState, market_id: u64, side: u8, position_key: felt252) {
            let mut m = self.market(market_id);
            let mut pos = self.positions.read((market_id, side, position_key));
            assert(pos.state == PositionState::Open, errors::NO_POSITION);
            let (r_b, r_o) = sides(@m, side);
            let (value, new_b, new_o) = pricing::sell(r_b, r_o, pos.shares);
            let notional = pos.margin + pos.borrowed;
            let equity = if value > pos.borrowed {
                value - pos.borrowed
            } else {
                0
            };
            let health = if notional == 0 {
                0
            } else {
                mul_div(equity, BPS, notional)
            };
            assert(health <= MAINTENANCE_MARGIN_BPS.into(), errors::HEALTHY);
            write_sides(ref m, side, new_b, new_o);
            self.total_backing.write(self.total_backing.read() - value);
            reduce_borrow(ref m, side, pos.borrowed);
            self.markets.write(market_id, m);
            let mut bad_debt = 0;
            if value >= pos.borrowed {
                self.vault_free.write(self.vault_free.read() + pos.borrowed);
                let surplus = value - pos.borrowed;
                let reward = min(mul_div(notional, KEEPER_REWARD_BPS, BPS), surplus);
                if reward != 0 {
                    self.erc20().transfer(get_caller_address(), reward.into());
                }
                self.insurance.write(self.insurance.read() + (surplus - reward));
            } else {
                self.vault_free.write(self.vault_free.read() + value);
                let gap = pos.borrowed - value;
                let ins = self.insurance.read();
                let cover = min(ins, gap);
                self.insurance.write(ins - cover);
                self.vault_free.write(self.vault_free.read() + cover);
                bad_debt = gap - cover;
            }
            pos.state = PositionState::Liquidated;
            pos.shares = 0;
            self.positions.write((market_id, side, position_key), pos);
            self
                .emit(
                    PositionLiquidated {
                        market_id, side, position_key, keeper: get_caller_address(), bad_debt,
                    },
                );
        }

        fn privacy_invoke(
            ref self: ContractState, action: LeverageAction,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.pool.read(), errors::UNAUTHORIZED_CALLER);
            match action {
                LeverageAction::Open(i) => self.do_open(i),
                LeverageAction::Close(c) => self.do_close(c),
            }
        }

        fn get_market(self: @ContractState, market_id: u64) -> LevMarket {
            self.market(market_id)
        }
        fn get_position(
            self: @ContractState, market_id: u64, side: u8, position_key: felt252,
        ) -> Position {
            self.positions.read((market_id, side, position_key))
        }
        fn price_bps(self: @ContractState, market_id: u64, side: u8) -> u16 {
            let (r_b, r_o) = sides(@self.market(market_id), side);
            pricing::price_bps(r_b, r_o)
        }
        fn position_equity(
            self: @ContractState, market_id: u64, side: u8, position_key: felt252,
        ) -> (u128, u128, u16) {
            let pos = self.positions.read((market_id, side, position_key));
            if pos.state != PositionState::Open || pos.shares == 0 {
                return (0, 0, 0);
            }
            let (r_b, r_o) = sides(@self.market(market_id), side);
            let (value, _, _) = pricing::sell(r_b, r_o, pos.shares);
            let notional = pos.margin + pos.borrowed;
            let equity = if value > pos.borrowed {
                value - pos.borrowed
            } else {
                0
            };
            let health: u16 = mul_div(equity, BPS, notional).try_into().unwrap();
            (value, equity, health)
        }
        fn get_n_markets(self: @ContractState) -> u64 {
            self.n_markets.read()
        }
        fn get_total_backing(self: @ContractState) -> u128 {
            self.total_backing.read()
        }
        fn get_vault_free(self: @ContractState) -> u128 {
            self.vault_free.read()
        }
        fn get_vault_shares(self: @ContractState, lp: ContractAddress) -> u128 {
            self.vault_shares.read(lp)
        }
        fn get_insurance(self: @ContractState) -> u128 {
            self.insurance.read()
        }
        fn get_pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }
        fn get_token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }
        // PLACEHOLDER_LEVIMPL2

    }

    fn mul_div(a: u128, b: u128, d: u128) -> u128 {
        let a256: u256 = a.into();
        let b256: u256 = b.into();
        let d256: u256 = d.into();
        (a256 * b256 / d256).try_into().unwrap()
    }

    fn min(a: u128, b: u128) -> u128 {
        if a < b {
            a
        } else {
            b
        }
    }

    fn sides(m: @LevMarket, side: u8) -> (u128, u128) {
        if side == SIDE_YES {
            (*m.r_yes, *m.r_no)
        } else {
            (*m.r_no, *m.r_yes)
        }
    }

    fn write_sides(ref m: LevMarket, side: u8, bought: u128, other: u128) {
        if side == SIDE_YES {
            m.r_yes = bought;
            m.r_no = other;
        } else {
            m.r_no = bought;
            m.r_yes = other;
        }
    }

    fn bump_borrow(ref m: LevMarket, side: u8, amt: u128) {
        if side == SIDE_YES {
            m.borrowed_yes += amt;
        } else {
            m.borrowed_no += amt;
        }
    }

    fn reduce_borrow(ref m: LevMarket, side: u8, amt: u128) {
        if side == SIDE_YES {
            m.borrowed_yes = if m.borrowed_yes >= amt {
                m.borrowed_yes - amt
            } else {
                0
            };
        } else {
            m.borrowed_no = if m.borrowed_no >= amt {
                m.borrowed_no - amt
            } else {
                0
            };
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn market(self: @ContractState, id: u64) -> LevMarket {
            assert(id < self.n_markets.read(), errors::NO_MARKET);
            self.markets.read(id)
        }

        fn erc20(self: @ContractState) -> IErc20Dispatcher {
            IErc20Dispatcher { contract_address: self.token.read() }
        }

        fn payout(
            ref self: ContractState, target: PayoutTarget, amount: u128,
        ) -> Span<OpenNoteDeposit> {
            if amount == 0 {
                return array![].span();
            }
            let token = self.token.read();
            match target {
                PayoutTarget::OpenNote(note_id) => {
                    self.erc20().approve(self.pool.read(), amount.into());
                    array![OpenNoteDeposit { note_id, token, amount }].span()
                },
                PayoutTarget::Address(recipient) => {
                    assert(recipient.is_non_zero(), errors::ZERO_RECIPIENT);
                    self.erc20().transfer(recipient, amount.into());
                    array![].span()
                },
            }
        }
        fn do_open(ref self: ContractState, i: OpenInput) -> Span<OpenNoteDeposit> {
            let mut m = self.market(i.market_id);
            assert(m.state == LevMarketState::Open, errors::MARKET_SETTLED);
            assert(get_block_timestamp() < m.close_at, errors::MARKET_CLOSED);
            assert(i.side == SIDE_YES || i.side == SIDE_NO, errors::BAD_SIDE);
            assert(i.position_key != 0, errors::ZERO_POSITION_KEY);
            assert(i.margin != 0, errors::ZERO_AMOUNT);
            assert(
                i.leverage_bps >= LEVERAGE_ONE && i.leverage_bps <= MAX_LEVERAGE,
                errors::BAD_LEVERAGE,
            );
            let existing = self.positions.read((i.market_id, i.side, i.position_key));
            assert(existing.state == PositionState::None, errors::POSITION_EXISTS);

            let notional = mul_div(i.margin, i.leverage_bps.into(), LEVERAGE_ONE.into());
            let borrowed = notional - i.margin;
            // The pool withdrew `margin` in first; verify it against the running invariant.
            let bal = self.erc20().balance_of(get_contract_address());
            let oblig: u256 = self.vault_free.read().into()
                + self.total_backing.read().into()
                + self.insurance.read().into()
                + i.margin.into();
            assert(bal >= oblig, errors::MARGIN_NOT_FUNDED);
            let free = self.vault_free.read();
            assert(free >= borrowed, errors::INSUFFICIENT_VAULT);

            let fee = mul_div(notional, OPEN_FEE_BPS, BPS);
            let invested = notional - fee;
            let (r_b, r_o) = sides(@m, i.side);
            let (shares, new_b, new_o) = pricing::buy(r_b, r_o, invested);
            assert(pricing::price_bps(new_b, new_o) <= i.max_price_bps, errors::SLIPPAGE);

            self.vault_free.write(free - borrowed);
            self.total_backing.write(self.total_backing.read() + invested);
            self.insurance.write(self.insurance.read() + fee);
            write_sides(ref m, i.side, new_b, new_o);
            bump_borrow(ref m, i.side, borrowed);
            self.markets.write(i.market_id, m);
            self
                .positions
                .write(
                    (i.market_id, i.side, i.position_key),
                    Position { shares, margin: i.margin, borrowed, state: PositionState::Open },
                );
            self
                .emit(
                    PositionOpened {
                        market_id: i.market_id,
                        side: i.side,
                        position_key: i.position_key,
                        margin: i.margin,
                        notional,
                        shares,
                    },
                );
            array![].span()
        }
        fn do_close(ref self: ContractState, c: CloseInput) -> Span<OpenNoteDeposit> {
            let mut m = self.market(c.market_id);
            let mut pos = self.positions.read((c.market_id, c.side, c.position_key));
            assert(pos.state == PositionState::Open, errors::NO_POSITION);
            let target_felt: felt252 = match c.target {
                PayoutTarget::OpenNote(_) => 0,
                PayoutTarget::Address(r) => {
                    assert(r.is_non_zero(), errors::ZERO_RECIPIENT);
                    r.into()
                },
            };
            let msg = poseidon_hash_span(
                array![
                    CLOSE_MESSAGE_TAG, get_contract_address().into(), c.market_id.into(),
                    c.side.into(), c.position_key, target_felt,
                ]
                    .span(),
            );
            assert(
                check_ecdsa_signature(msg, c.position_key, c.signature_r, c.signature_s),
                errors::BAD_CLOSE_SIGNATURE,
            );

            let (r_b, r_o) = sides(@m, c.side);
            let (value, new_b, new_o) = pricing::sell(r_b, r_o, pos.shares);
            write_sides(ref m, c.side, new_b, new_o);
            reduce_borrow(ref m, c.side, pos.borrowed);
            self.markets.write(c.market_id, m);
            self.total_backing.write(self.total_backing.read() - value);

            let equity = if value > pos.borrowed {
                value - pos.borrowed
            } else {
                0
            };
            let repay = value - equity; // min(value, borrowed)
            self.vault_free.write(self.vault_free.read() + repay);
            if value < pos.borrowed {
                let gap = pos.borrowed - value;
                let ins = self.insurance.read();
                let cover = min(ins, gap);
                self.insurance.write(ins - cover);
                self.vault_free.write(self.vault_free.read() + cover);
            }
            pos.state = PositionState::Closed;
            pos.shares = 0;
            self.positions.write((c.market_id, c.side, c.position_key), pos);
            self
                .emit(
                    PositionClosed {
                        market_id: c.market_id,
                        side: c.side,
                        position_key: c.position_key,
                        payout: equity,
                    },
                );
            self.payout(c.target, equity)
        }
        // PLACEHOLDER_LEVCLOSE

    }
}
