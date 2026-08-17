use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
};
use veilcast::interface::{IVeilcastMarketDispatcherTrait, MarketState, errors as market_errors};
use veilcast::pragma_resolver::{
    IPragmaResolverDispatcher, IPragmaResolverDispatcherTrait, IPragmaResolverSafeDispatcher,
    IPragmaResolverSafeDispatcherTrait, OUTCOME_AT_OR_ABOVE, OUTCOME_BELOW, PriceQuestion, errors,
};
use veilcast::test_utils_contracts::mock_pool::IMockPoolDispatcherTrait;
use veilcast::test_utils_contracts::mock_pragma::{
    IMockPragmaOracleDispatcher, IMockPragmaOracleDispatcherTrait,
};
use veilcast::tests::test_utils::{
    ONE_STRK, Veilcast, VeilcastTrait, assert_panic, deploy_veilcast, new_coupon,
};

/// STRK/USD as Pragma names it, reported at 8 decimals, so one dollar is 100000000.
const STRK_USD: felt252 = 'STRK/USD';
const ONE_DOLLAR: u128 = 100_000_000;
const CLOSE_AT: u64 = 100_000;
/// A median older than this cannot settle a market.
const MAX_PRICE_AGE: u64 = 3600;

#[derive(Drop, Copy)]
struct PriceMarket {
    veilcast: Veilcast,
    resolver: IPragmaResolverDispatcher,
    oracle: IMockPragmaOracleDispatcher,
}

fn deploy_price_market() -> PriceMarket {
    let veilcast = deploy_veilcast();
    let (oracle_address, _) = declare("MockPragmaOracle")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();
    let (resolver_address, _) = declare("PragmaResolver")
        .unwrap()
        .contract_class()
        .deploy(
            @array![
                veilcast.market.contract_address.into(), oracle_address.into(),
                MAX_PRICE_AGE.into(),
            ],
        )
        .unwrap();
    PriceMarket {
        veilcast,
        resolver: IPragmaResolverDispatcher { contract_address: resolver_address },
        oracle: IMockPragmaOracleDispatcher { contract_address: oracle_address },
    }
}

#[generate_trait]
impl PriceMarketImpl of PriceMarketTrait {
    /// Opens "will STRK close at or above one dollar", closing at `CLOSE_AT`.
    fn open(self: @PriceMarket) -> u64 {
        (*self.resolver)
            .open_price_market(
                question: "Will STRK close above 1 USD?",
                label_at_or_above: "Yes",
                label_below: "No",
                close_at: CLOSE_AT,
                category: 'Crypto',
                pair_id: STRK_USD,
                threshold: ONE_DOLLAR,
            )
    }

    /// Puts a median on the feed, with twelve publishers behind it like the live one has.
    fn publish(self: @PriceMarket, price: u128, last_updated_timestamp: u64) {
        (*self.oracle)
            .set_median(
                pair_id: STRK_USD,
                :price,
                decimals: 8,
                :last_updated_timestamp,
                num_sources_aggregated: 12,
            );
    }

    fn safe_resolver(self: @PriceMarket) -> IPragmaResolverSafeDispatcher {
        IPragmaResolverSafeDispatcher { contract_address: *self.resolver.contract_address }
    }
}
#[test]
fn test_open_price_market_binds_the_feed_and_holds_the_resolver_role() {
    let price_market = deploy_price_market();

    let market_id = price_market.open();

    let market = price_market.veilcast.market.get_market(market_id);
    assert_eq!(market.resolver, price_market.resolver.contract_address);
    assert_eq!(market.n_outcomes, 2);
    assert_eq!(market.close_at, CLOSE_AT);
    assert_eq!(
        price_market.veilcast.market.get_question(market_id), "Will STRK close above 1 USD?",
    );
    assert_eq!(
        price_market.veilcast.market.get_outcome_label(market_id, OUTCOME_AT_OR_ABOVE), "Yes",
    );
    assert_eq!(price_market.veilcast.market.get_outcome_label(market_id, OUTCOME_BELOW), "No");
    assert_eq!(
        price_market.resolver.get_price_question(market_id),
        PriceQuestion { pair_id: STRK_USD, threshold: ONE_DOLLAR },
    );
    assert_eq!(price_market.resolver.get_max_price_age(), MAX_PRICE_AGE);
    assert_eq!(price_market.resolver.get_market(), price_market.veilcast.market.contract_address);
    assert_eq!(price_market.resolver.get_oracle(), price_market.oracle.contract_address);
}

/// The whole point: nobody decides this. A market above its threshold settles on the outcome above,
/// one below settles below, and the caller is just whoever paid the gas.
#[test]
fn test_settle_resolves_whichever_way_the_median_falls() {
    let price_market = deploy_price_market();
    let above = price_market.open();
    let below = price_market.open();

    price_market
        .veilcast
        .bet(
            market_id: above,
            outcome: OUTCOME_AT_OR_ABOVE,
            amount: ONE_STRK,
            position_key: new_coupon().public_key,
        );
    price_market
        .veilcast
        .bet(
            market_id: below,
            outcome: OUTCOME_BELOW,
            amount: ONE_STRK,
            position_key: new_coupon().public_key,
        );
    start_cheat_block_timestamp_global(CLOSE_AT);

    // A dollar twenty, well inside the freshness window.
    price_market.publish(price: 120_000_000, last_updated_timestamp: CLOSE_AT - 60);
    price_market.resolver.settle(market_id: above);
    let settled_above = price_market.veilcast.market.get_market(above);
    assert_eq!(settled_above.state, MarketState::Resolved);
    assert_eq!(settled_above.winning_outcome, OUTCOME_AT_OR_ABOVE);

    // Ninety nine cents settles the other way, and exactly one dollar would settle above.
    price_market.publish(price: 99_000_000, last_updated_timestamp: CLOSE_AT - 60);
    price_market.resolver.settle(market_id: below);
    let settled_below = price_market.veilcast.market.get_market(below);
    assert_eq!(settled_below.state, MarketState::Resolved);
    assert_eq!(settled_below.winning_outcome, OUTCOME_BELOW);
}

/// The threshold is a line, not a range, so the boundary has to be pinned: at the threshold settles
/// above it, one unit under settles below.
#[test]
fn test_settle_at_the_threshold_settles_above_it() {
    let price_market = deploy_price_market();
    let market_id = price_market.open();
    price_market
        .veilcast
        .bet(
            :market_id,
            outcome: OUTCOME_AT_OR_ABOVE,
            amount: ONE_STRK,
            position_key: new_coupon().public_key,
        );
    start_cheat_block_timestamp_global(CLOSE_AT);

    price_market.publish(price: ONE_DOLLAR, last_updated_timestamp: CLOSE_AT);
    price_market.resolver.settle(:market_id);

    assert_eq!(
        price_market.veilcast.market.get_market(market_id).winning_outcome, OUTCOME_AT_OR_ABOVE,
    );
}
/// A feed that has gone quiet must not settle anything. Zero publishers is the oracle saying it has
/// no opinion, and a months-old median is not a closing price, so both are refused and the market
/// falls back to the public void everyone can trigger 30 days after the close.
#[test]
#[feature("safe_dispatcher")]
fn test_settle_refuses_a_feed_it_should_not_trust() {
    let price_market = deploy_price_market();
    let market_id = price_market.open();
    let resolver = price_market.safe_resolver();
    price_market
        .veilcast
        .bet(
            :market_id,
            outcome: OUTCOME_AT_OR_ABOVE,
            amount: ONE_STRK,
            position_key: new_coupon().public_key,
        );
    start_cheat_block_timestamp_global(CLOSE_AT);

    // Nothing published at all: the pair reads back with no sources.
    assert_panic(resolver.settle(:market_id), errors::NO_PRICE_DATA);

    // A median from before the window opened.
    price_market.publish(price: 120_000_000, last_updated_timestamp: CLOSE_AT - MAX_PRICE_AGE - 1);
    assert_panic(resolver.settle(:market_id), errors::PRICE_TOO_OLD);

    // The oldest median that still counts settles it.
    price_market.publish(price: 120_000_000, last_updated_timestamp: CLOSE_AT - MAX_PRICE_AGE);
    resolver.settle(:market_id).unwrap();
    assert_eq!(price_market.veilcast.market.get_market(market_id).state, MarketState::Resolved);
}

#[test]
#[feature("safe_dispatcher")]
fn test_settle_guards() {
    let price_market = deploy_price_market();
    let market_id = price_market.open();
    let resolver = price_market.safe_resolver();
    price_market.publish(price: 120_000_000, last_updated_timestamp: CLOSE_AT);
    // Staked before the close, because a closed market takes no bets.
    price_market
        .veilcast
        .bet(
            :market_id,
            outcome: OUTCOME_AT_OR_ABOVE,
            amount: ONE_STRK,
            position_key: new_coupon().public_key,
        );

    // A market this resolver never opened is not one it can settle, whatever the feed says.
    assert_panic(resolver.settle(market_id: 7), errors::NO_PRICE_QUESTION);
    // The market refuses its own settlement before it closes, and this contract does not get to
    // override that.
    assert_panic(resolver.settle(:market_id), market_errors::MARKET_NOT_CLOSED);

    start_cheat_block_timestamp_global(CLOSE_AT);
    resolver.settle(:market_id).unwrap();
    // And once settled it stays settled, however many times the feed is pushed at it.
    assert_panic(resolver.settle(:market_id), market_errors::MARKET_SETTLED);
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_price_market_rejects_a_question_with_no_feed_behind_it() {
    let price_market = deploy_price_market();
    let resolver = price_market.safe_resolver();

    assert_panic(
        resolver
            .open_price_market(
                question: "Q",
                label_at_or_above: "Yes",
                label_below: "No",
                close_at: CLOSE_AT,
                category: 'Crypto',
                pair_id: 0,
                threshold: ONE_DOLLAR,
            ),
        errors::ZERO_PAIR_ID,
    );
    assert_panic(
        resolver
            .open_price_market(
                question: "Q",
                label_at_or_above: "Yes",
                label_below: "No",
                close_at: CLOSE_AT,
                category: 'Crypto',
                pair_id: STRK_USD,
                threshold: 0,
            ),
        errors::ZERO_THRESHOLD,
    );
    assert_eq!(price_market.veilcast.market.get_n_markets(), 0);
}

/// End to end: a bet placed through the pool, a settlement the feed decided, a payout collected
/// into a private note. The bettor never appears anywhere in it.
#[test]
fn test_a_feed_settled_market_pays_its_winning_coupon() {
    let price_market = deploy_price_market();
    let market_id = price_market.open();
    let winner = new_coupon();
    price_market
        .veilcast
        .bet(
            :market_id,
            outcome: OUTCOME_AT_OR_ABOVE,
            amount: 3 * ONE_STRK,
            position_key: winner.public_key,
        );
    price_market
        .veilcast
        .bet(
            :market_id,
            outcome: OUTCOME_BELOW,
            amount: ONE_STRK,
            position_key: new_coupon().public_key,
        );

    start_cheat_block_timestamp_global(CLOSE_AT);
    price_market.publish(price: 250_000_000, last_updated_timestamp: CLOSE_AT);
    price_market.resolver.settle(:market_id);

    // The whole 4 STRK pot goes to the only coupon on the winning side.
    price_market
        .veilcast
        .claim_to_note(:market_id, outcome: OUTCOME_AT_OR_ABOVE, coupon: winner, note_id: 'NOTE');
    assert_eq!(price_market.veilcast.pool.get_note_amount('NOTE'), 4 * ONE_STRK);
    assert_eq!(price_market.veilcast.market.get_total_escrow(), 0);
}

/// The median a UI shows next to a live price market is the one that will settle it.
#[test]
fn test_read_median_reports_what_the_feed_says() {
    let price_market = deploy_price_market();
    price_market.publish(price: 120_000_000, last_updated_timestamp: 900);

    assert_eq!(price_market.resolver.read_median(STRK_USD), (120_000_000, 8, 900));
    // A pair nobody publishes reads back empty rather than reverting, so a UI can say so.
    assert_eq!(price_market.resolver.read_median('NOPE/USD'), (0, 0, 0));
}
