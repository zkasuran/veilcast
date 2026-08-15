//! The Veilcast market: a parimutuel prediction market the STRK20 privacy pool bets on behalf of.
//!
//! Stakes and payouts move through the pool, so the contract never sees a bettor address. What it
//! does see, and what it publishes, is the amount and the outcome. That split is the design:
//! hidden sizes would make the odds meaningless, hidden identities keep the flow honest.
//!
//! A position is a bearer coupon. The bettor generates a Stark keypair off-chain, passes the
//! public key with the bet, then signs a claim message with the private key to collect. Nothing
//! stored here ties a coupon to a person, and the pool never tells the market who called.

use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;

/// Bounds `create_market` and every loop over outcomes.
pub const MAX_OUTCOMES: u8 = 8;

/// How long after `close_at` anyone may void a market the resolver never settled (30 days).
pub const VOID_GRACE: u64 = 2592000;

/// Domain separator for the claim message, so a coupon signature means nothing anywhere else.
pub const CLAIM_MESSAGE_TAG: felt252 = 'VEILCAST_CLAIM';

/// The message a position's owner signs to release its payout.
///
/// `h(CLAIM_MESSAGE_TAG, market_address, market_id, outcome, position_key, target)`, Poseidon over
/// a span, which is what `poseidonHashMany` produces in starknet.js. `target` is zero for a bearer
/// claim into an open note, or the recipient address for a claim bound to one address, so a
/// signature that names an address can never be redirected to another.
pub fn claim_message_hash(
    market_address: ContractAddress,
    market_id: u64,
    outcome: u8,
    position_key: felt252,
    target: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            CLAIM_MESSAGE_TAG, market_address.into(), market_id.into(), outcome.into(),
            position_key, target,
        ]
            .span(),
    )
}
#[starknet::contract]
pub mod VeilcastMarket {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::{CheckedAdd, SaturatingAdd, Zero};
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use veilcast::interface::{
        BetInput, ClaimInput, IErc20Dispatcher, IErc20DispatcherTrait, IVeilcastMarket, Market,
        MarketAction, MarketState, OpenNoteDeposit, PayoutTarget, errors,
    };
    use super::{MAX_OUTCOMES, VOID_GRACE, claim_message_hash};

    #[storage]
    struct Storage {
        /// The privacy pool allowed to invoke this market. Set once, at construction.
        pool: ContractAddress,
        /// The single ERC20 every market is denominated in.
        token: ContractAddress,
        n_markets: u64,
        /// Tokens owed to open positions and unclaimed payouts. A bet is only credited when the
        /// contract's balance covers this plus the new stake, which is how the market checks that
        /// the pool really withdrew the money before invoking.
        total_escrow: u128,
        markets: Map<u64, Market>,
        questions: Map<u64, ByteArray>,
        outcome_labels: Map<(u64, u8), ByteArray>,
        outcome_volumes: Map<(u64, u8), u128>,
        stakes: Map<(u64, u8, felt252), u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        MarketCreated: MarketCreated,
        BetPlaced: BetPlaced,
        MarketResolved: MarketResolved,
        MarketVoided: MarketVoided,
        PayoutClaimed: PayoutClaimed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketCreated {
        #[key]
        pub market_id: u64,
        pub resolver: ContractAddress,
        pub close_at: u64,
        pub n_outcomes: u8,
    }
    /// The public half of a bet: how much went on which outcome, and the volume it lands in.
    /// Carries no address, because the market is never told one.
    #[derive(Drop, starknet::Event)]
    pub struct BetPlaced {
        #[key]
        pub market_id: u64,
        #[key]
        pub outcome: u8,
        #[key]
        pub position_key: felt252,
        pub amount: u128,
        pub outcome_volume: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketResolved {
        #[key]
        pub market_id: u64,
        pub winning_outcome: u8,
        pub pot: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketVoided {
        #[key]
        pub market_id: u64,
    }

    /// Links a coupon to its payout, which links a bet to a claim. Both ends are anonymous: the
    /// coupon key is public from the moment the bet lands, and neither end carries an address.
    #[derive(Drop, starknet::Event)]
    pub struct PayoutClaimed {
        #[key]
        pub market_id: u64,
        #[key]
        pub position_key: felt252,
        pub amount: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool: ContractAddress, token: ContractAddress) {
        assert(pool.is_non_zero(), errors::ZERO_POOL);
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
        self.pool.write(pool);
        self.token.write(token);
    }
    #[abi(embed_v0)]
    pub impl VeilcastMarketImpl of IVeilcastMarket<ContractState> {
        fn create_market(
            ref self: ContractState,
            question: ByteArray,
            outcome_labels: Array<ByteArray>,
            resolver: ContractAddress,
            close_at: u64,
        ) -> u64 {
            let n_labels = outcome_labels.len();
            assert(n_labels >= 2, errors::TOO_FEW_OUTCOMES);
            assert(n_labels <= MAX_OUTCOMES.into(), errors::TOO_MANY_OUTCOMES);
            assert(resolver.is_non_zero(), errors::ZERO_RESOLVER);
            assert(close_at > get_block_timestamp(), errors::CLOSE_IN_PAST);

            let market_id = self.n_markets.read();
            self.n_markets.write(market_id + 1);
            self.questions.entry(market_id).write(question);
            let mut n_outcomes: u8 = 0;
            for label in outcome_labels {
                self.outcome_labels.entry((market_id, n_outcomes)).write(label);
                n_outcomes += 1;
            }
            self
                .markets
                .entry(market_id)
                .write(
                    Market {
                        resolver,
                        close_at,
                        n_outcomes,
                        state: MarketState::Open,
                        winning_outcome: 0,
                        pot: 0,
                    },
                );
            self.emit(MarketCreated { market_id, resolver, close_at, n_outcomes });
            market_id
        }

        fn resolve(ref self: ContractState, market_id: u64, winning_outcome: u8) {
            let mut market = self.assert_market(market_id);
            assert(get_caller_address() == market.resolver, errors::NOT_RESOLVER);
            assert(market.state == MarketState::Open, errors::MARKET_SETTLED);
            assert(get_block_timestamp() >= market.close_at, errors::MARKET_NOT_CLOSED);
            assert(winning_outcome < market.n_outcomes, errors::NO_SUCH_OUTCOME);

            // Nobody backed the winner, so there is no one to pay the pot to. Void instead of
            // stranding it.
            if self.outcome_volumes.entry((market_id, winning_outcome)).read().is_zero() {
                self.void_market(:market_id, ref :market);
                return;
            }
            market.state = MarketState::Resolved;
            market.winning_outcome = winning_outcome;
            self.markets.entry(market_id).write(market);
            self.emit(MarketResolved { market_id, winning_outcome, pot: market.pot });
        }

        fn void(ref self: ContractState, market_id: u64) {
            let mut market = self.assert_market(market_id);
            assert(market.state == MarketState::Open, errors::MARKET_SETTLED);
            if get_caller_address() != market.resolver {
                assert(
                    get_block_timestamp() >= market.close_at.saturating_add(VOID_GRACE),
                    errors::VOID_TOO_EARLY,
                );
            }
            self.void_market(:market_id, ref :market);
        }

        fn privacy_invoke(ref self: ContractState, action: MarketAction) -> Span<OpenNoteDeposit> {
            // Only the pool may drive the market. A bet placed directly would be a position tied
            // to a public address, which is both a lie about the privacy model and a smaller
            // anonymity set for everyone else, so there is no direct path in.
            assert(get_caller_address() == self.pool.read(), errors::UNAUTHORIZED_CALLER);
            match action {
                MarketAction::Bet(input) => self.place_bet(input),
                MarketAction::Claim(input) => self.collect_payout(input),
            }
        }

        fn get_market(self: @ContractState, market_id: u64) -> Market {
            self.assert_market(market_id)
        }

        fn get_question(self: @ContractState, market_id: u64) -> ByteArray {
            self.assert_market(market_id);
            self.questions.entry(market_id).read()
        }

        fn get_outcome_label(self: @ContractState, market_id: u64, outcome: u8) -> ByteArray {
            let market = self.assert_market(market_id);
            assert(outcome < market.n_outcomes, errors::NO_SUCH_OUTCOME);
            self.outcome_labels.entry((market_id, outcome)).read()
        }

        fn get_outcome_volumes(self: @ContractState, market_id: u64) -> Span<u128> {
            let market = self.assert_market(market_id);
            let mut volumes: Array<u128> = array![];
            let mut outcome: u8 = 0;
            while outcome < market.n_outcomes {
                volumes.append(self.outcome_volumes.entry((market_id, outcome)).read());
                outcome += 1;
            }
            volumes.span()
        }

        fn get_stake(
            self: @ContractState, market_id: u64, outcome: u8, position_key: felt252,
        ) -> u128 {
            self.stakes.entry((market_id, outcome, position_key)).read()
        }

        fn quote_payout(self: @ContractState, market_id: u64, outcome: u8, stake: u128) -> u128 {
            let market = self.assert_market(market_id);
            assert(outcome < market.n_outcomes, errors::NO_SUCH_OUTCOME);
            if market.state == MarketState::Void {
                return stake;
            }
            let outcome_volume = self.outcome_volumes.entry((market_id, outcome)).read();
            if market.state == MarketState::Resolved {
                if outcome != market.winning_outcome {
                    return 0;
                }
                return payout_share(:stake, pot: market.pot, winning_volume: outcome_volume);
            }
            // Still open, so quote as if this stake were placed now and this outcome then won.
            payout_share(
                :stake,
                pot: market.pot.saturating_add(stake),
                winning_volume: outcome_volume.saturating_add(stake),
            )
        }

        fn get_n_markets(self: @ContractState) -> u64 {
            self.n_markets.read()
        }

        fn get_pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }

        fn get_token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }

        fn get_total_escrow(self: @ContractState) -> u128 {
            self.total_escrow.read()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Credits a stake to `(market_id, outcome, position_key)` once the tokens are here.
        fn place_bet(ref self: ContractState, input: BetInput) -> Span<OpenNoteDeposit> {
            let BetInput { market_id, outcome, amount, position_key } = input;
            let mut market = self.assert_market(market_id);
            assert(market.state == MarketState::Open, errors::MARKET_SETTLED);
            assert(get_block_timestamp() < market.close_at, errors::MARKET_CLOSED);
            assert(outcome < market.n_outcomes, errors::NO_SUCH_OUTCOME);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(position_key.is_non_zero(), errors::ZERO_POSITION_KEY);

            // The pool withdraws the stake here before it invokes, so the tokens must already sit
            // on top of everything earlier bets escrowed. A caller who claims more than arrived is
            // rejected; a surplus somebody sent unasked is never credited beyond this check.
            let total_escrow = self.total_escrow.read();
            let funded = total_escrow.checked_add(amount).expect(errors::POT_OVERFLOW);
            let balance = IErc20Dispatcher { contract_address: self.token.read() }
                .balance_of(account: get_contract_address());
            assert(balance >= funded.into(), errors::STAKE_NOT_FUNDED);
            self.total_escrow.write(funded);

            let volume_entry = self.outcome_volumes.entry((market_id, outcome));
            let outcome_volume = volume_entry
                .read()
                .checked_add(amount)
                .expect(errors::POT_OVERFLOW);
            volume_entry.write(outcome_volume);
            let stake_entry = self.stakes.entry((market_id, outcome, position_key));
            stake_entry.write(stake_entry.read().checked_add(amount).expect(errors::POT_OVERFLOW));
            market.pot = market.pot.checked_add(amount).expect(errors::POT_OVERFLOW);
            self.markets.entry(market_id).write(market);

            self.emit(BetPlaced { market_id, outcome, position_key, amount, outcome_volume });
            // A bet creates no open note: the stake stays escrowed here until the market settles,
            // so the pool has nothing to deposit.
            array![].span()
        }

        /// Pays a settled position out, into an open note or to the address its coupon named.
        fn collect_payout(ref self: ContractState, input: ClaimInput) -> Span<OpenNoteDeposit> {
            let ClaimInput {
                market_id, outcome, position_key, signature_r, signature_s, target,
            } = input;
            let market = self.assert_market(market_id);
            let stake_entry = self.stakes.entry((market_id, outcome, position_key));
            let stake = stake_entry.read();
            assert(stake.is_non_zero(), errors::NO_POSITION);

            let payout = if market.state == MarketState::Void {
                stake
            } else {
                assert(market.state == MarketState::Resolved, errors::MARKET_UNSETTLED);
                assert(outcome == market.winning_outcome, errors::LOSING_POSITION);
                payout_share(
                    :stake,
                    pot: market.pot,
                    winning_volume: self.outcome_volumes.entry((market_id, outcome)).read(),
                )
            };

            let signed_target = match target {
                // Zero means bearer: the wallet picks the open note id during assembly, so it
                // cannot be signed ahead of time.
                PayoutTarget::OpenNote(_) => 0,
                PayoutTarget::Address(recipient) => {
                    assert(recipient.is_non_zero(), errors::ZERO_RECIPIENT);
                    recipient.into()
                },
            };
            assert(
                check_ecdsa_signature(
                    message_hash: claim_message_hash(
                        market_address: get_contract_address(),
                        :market_id,
                        :outcome,
                        :position_key,
                        target: signed_target,
                    ),
                    public_key: position_key,
                    :signature_r,
                    :signature_s,
                ),
                errors::BAD_CLAIM_SIGNATURE,
            );

            // Spend the position and the escrow before any external call, so the coupon pays once
            // whatever the payout path does.
            stake_entry.write(0);
            self.total_escrow.write(self.total_escrow.read() - payout);
            self.emit(PayoutClaimed { market_id, position_key, amount: payout });

            let token = self.token.read();
            let erc20 = IErc20Dispatcher { contract_address: token };
            match target {
                PayoutTarget::OpenNote(note_id) => {
                    // The pool pulls the payout into the open note as soon as this returns.
                    erc20.approve(spender: self.pool.read(), amount: payout.into());
                    array![OpenNoteDeposit { note_id, token, amount: payout }].span()
                },
                PayoutTarget::Address(recipient) => {
                    erc20.transfer(:recipient, amount: payout.into());
                    array![].span()
                },
            }
        }

        fn void_market(ref self: ContractState, market_id: u64, ref market: Market) {
            market.state = MarketState::Void;
            self.markets.entry(market_id).write(market);
            self.emit(MarketVoided { market_id });
        }

        /// Reads a market that exists. Ids are handed out in sequence from zero, so anything at or
        /// past `n_markets` was never created and would otherwise read back as a zeroed market.
        fn assert_market(self: @ContractState, market_id: u64) -> Market {
            assert(market_id < self.n_markets.read(), errors::NO_MARKET);
            self.markets.entry(market_id).read()
        }
    }

    /// The parimutuel share: `stake * pot / winning_volume`, or zero when nothing backs the
    /// winning outcome.
    ///
    /// Widened to `u256` because `stake * pot` overflows `u128` long before either factor does.
    /// Integer division truncates, so dust below one token unit stays escrowed here.
    fn payout_share(stake: u128, pot: u128, winning_volume: u128) -> u128 {
        if winning_volume.is_zero() {
            return 0;
        }
        let share: u256 = stake.into() * pot.into() / winning_volume.into();
        share.try_into().expect(errors::PAYOUT_OVERFLOW)
    }
}
