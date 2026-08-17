//! Settles a Veilcast price market from a Pragma feed.
//!
//! A market names one resolver address, and that address is the only thing that can settle it.
//! Point it at this contract and the settlement stops being a judgment call: the market is bound to
//! a pair and a threshold when it is opened, and afterwards anyone may push the feed's median into
//! it.
//! There is no admin here, no owner and no path that settles a market against what the feed says.
//!
//! What this deliberately does not do is void. A void from here would have to be permissionless,
//! which would let anyone cancel a live market, so a feed that dies is left to the market's own
//! rule:
//! 30 days past the close, anyone can void it and every stake is refundable.

use starknet::ContractAddress;

/// Outcome 0 is the one that wins when the median is at or above the threshold, outcome 1 the one
/// below it. Fixed here rather than chosen per market, so a bettor reading the board never has to
/// wonder which way round a particular market was wired.
pub const OUTCOME_AT_OR_ABOVE: u8 = 0;
pub const OUTCOME_BELOW: u8 = 1;

/// What a market was bound to when it was opened.
#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct PriceQuestion {
    /// Pragma spot pair id: the ticker as a short string, `'STRK/USD'`.
    pub pair_id: felt252,
    /// The line the question is about, in the feed's own decimals. STRK/USD reports 8, so one
    /// dollar is 100000000.
    pub threshold: u128,
}

#[starknet::interface]
pub trait IPragmaResolver<TState> {
    /// Opens a market on the Veilcast market contract with this contract as its resolver, bound to
    /// `pair_id` and `threshold`. Returns the new market's id. Permissionless: anyone may open one,
    /// and nobody gains anything by doing so.
    fn open_price_market(
        ref self: TState,
        question: ByteArray,
        label_at_or_above: ByteArray,
        label_below: ByteArray,
        close_at: u64,
        category: felt252,
        pair_id: felt252,
        threshold: u128,
    ) -> u64;

    /// Settles a bound market from the feed. Callable by anyone, once the market has closed, which
    /// the market itself enforces. Refuses a median with no publishers behind it or one older than
    /// `max_price_age`, so a dead feed cannot settle a market on a stale number.
    fn settle(ref self: TState, market_id: u64);

    fn get_price_question(self: @TState, market_id: u64) -> PriceQuestion;
    /// The median the feed reports for `pair_id` right now: `(price, decimals, last_updated)`. What
    /// a UI shows next to a price market so the number that will settle it is visible beforehand.
    fn read_median(self: @TState, pair_id: felt252) -> (u128, u32, u64);
    fn get_market(self: @TState) -> ContractAddress;
    fn get_oracle(self: @TState) -> ContractAddress;
    fn get_max_price_age(self: @TState) -> u64;
}

pub mod errors {
    pub const ZERO_MARKET: felt252 = 'ZERO_MARKET';
    pub const ZERO_ORACLE: felt252 = 'ZERO_ORACLE';
    pub const ZERO_MAX_PRICE_AGE: felt252 = 'ZERO_MAX_PRICE_AGE';
    pub const ZERO_PAIR_ID: felt252 = 'ZERO_PAIR_ID';
    pub const ZERO_THRESHOLD: felt252 = 'ZERO_THRESHOLD';
    pub const NO_PRICE_QUESTION: felt252 = 'NO_PRICE_QUESTION';
    pub const NO_PRICE_DATA: felt252 = 'NO_PRICE_DATA';
    pub const PRICE_TOO_OLD: felt252 = 'PRICE_TOO_OLD';
}

#[starknet::contract]
pub mod PragmaResolver {
    use core::num::traits::{SaturatingAdd, Zero};
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_contract_address};
    use veilcast::interface::{IVeilcastMarketDispatcher, IVeilcastMarketDispatcherTrait};
    use veilcast::pragma::{DataType, IPragmaOracleDispatcher, IPragmaOracleDispatcherTrait};
    use super::{IPragmaResolver, OUTCOME_AT_OR_ABOVE, OUTCOME_BELOW, PriceQuestion, errors};

    #[storage]
    struct Storage {
        market: ContractAddress,
        oracle: ContractAddress,
        /// How stale a median may be and still settle a market, in seconds.
        max_price_age: u64,
        questions: Map<u64, PriceQuestion>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        PriceMarketOpened: PriceMarketOpened,
        PriceMarketSettled: PriceMarketSettled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PriceMarketOpened {
        #[key]
        pub market_id: u64,
        #[key]
        pub pair_id: felt252,
        pub threshold: u128,
        pub close_at: u64,
    }

    /// The median that settled a market, kept next to the outcome it produced so the settlement can
    /// be checked against the feed's own history rather than taken on trust.
    #[derive(Drop, starknet::Event)]
    pub struct PriceMarketSettled {
        #[key]
        pub market_id: u64,
        pub price: u128,
        pub last_updated_timestamp: u64,
        pub winning_outcome: u8,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        market: ContractAddress,
        oracle: ContractAddress,
        max_price_age: u64,
    ) {
        assert(market.is_non_zero(), errors::ZERO_MARKET);
        assert(oracle.is_non_zero(), errors::ZERO_ORACLE);
        assert(max_price_age.is_non_zero(), errors::ZERO_MAX_PRICE_AGE);
        self.market.write(market);
        self.oracle.write(oracle);
        self.max_price_age.write(max_price_age);
    }
    #[abi(embed_v0)]
    pub impl PragmaResolverImpl of IPragmaResolver<ContractState> {
        fn open_price_market(
            ref self: ContractState,
            question: ByteArray,
            label_at_or_above: ByteArray,
            label_below: ByteArray,
            close_at: u64,
            category: felt252,
            pair_id: felt252,
            threshold: u128,
        ) -> u64 {
            assert(pair_id.is_non_zero(), errors::ZERO_PAIR_ID);
            assert(threshold.is_non_zero(), errors::ZERO_THRESHOLD);
            // The market hands out ids in sequence, so a binding written here can never land on a
            // market that already has one.
            let market_id = IVeilcastMarketDispatcher { contract_address: self.market.read() }
                .create_market(
                    :question,
                    outcome_labels: array![label_at_or_above, label_below],
                    resolver: get_contract_address(),
                    :close_at,
                    :category,
                );
            self.questions.entry(market_id).write(PriceQuestion { pair_id, threshold });
            self.emit(PriceMarketOpened { market_id, pair_id, threshold, close_at });
            market_id
        }

        fn settle(ref self: ContractState, market_id: u64) {
            let question = self.questions.entry(market_id).read();
            assert(question.pair_id.is_non_zero(), errors::NO_PRICE_QUESTION);
            let median = IPragmaOracleDispatcher { contract_address: self.oracle.read() }
                .get_data_median(data_type: DataType::SpotEntry(question.pair_id));
            // Zero publishers is the feed saying it has nothing, which is not a price of zero.
            assert(median.num_sources_aggregated.is_non_zero(), errors::NO_PRICE_DATA);
            assert(
                get_block_timestamp() <= median
                    .last_updated_timestamp
                    .saturating_add(self.max_price_age.read()),
                errors::PRICE_TOO_OLD,
            );

            let winning_outcome = if median.price >= question.threshold {
                OUTCOME_AT_OR_ABOVE
            } else {
                OUTCOME_BELOW
            };
            // The market refuses this before its close, and refuses a second one after it.
            IVeilcastMarketDispatcher { contract_address: self.market.read() }
                .resolve(:market_id, :winning_outcome);
            self
                .emit(
                    PriceMarketSettled {
                        market_id,
                        price: median.price,
                        last_updated_timestamp: median.last_updated_timestamp,
                        winning_outcome,
                    },
                );
        }

        fn get_price_question(self: @ContractState, market_id: u64) -> PriceQuestion {
            self.questions.entry(market_id).read()
        }

        fn read_median(self: @ContractState, pair_id: felt252) -> (u128, u32, u64) {
            let median = IPragmaOracleDispatcher { contract_address: self.oracle.read() }
                .get_data_median(data_type: DataType::SpotEntry(pair_id));
            (median.price, median.decimals, median.last_updated_timestamp)
        }

        fn get_market(self: @ContractState) -> ContractAddress {
            self.market.read()
        }

        fn get_oracle(self: @ContractState) -> ContractAddress {
            self.oracle.read()
        }

        fn get_max_price_age(self: @ContractState) -> u64 {
            self.max_price_age.read()
        }
    }
}
