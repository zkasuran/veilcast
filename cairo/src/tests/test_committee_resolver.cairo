use core::num::traits::Zero;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veilcast::committee_resolver::{
    Committee, ICommitteeResolverDispatcher, ICommitteeResolverDispatcherTrait,
    ICommitteeResolverSafeDispatcher, ICommitteeResolverSafeDispatcherTrait, VOID_CHOICE, errors,
};
use veilcast::interface::{IVeilcastMarketDispatcherTrait, MarketState};
use veilcast::test_utils_contracts::mock_pool::IMockPoolDispatcherTrait;
use veilcast::tests::test_utils::{
    ONE_STRK, Veilcast, VeilcastTrait, assert_panic, deploy_veilcast, new_coupon,
};

const CLOSE_AT: u64 = 1000;

fn juror(name: felt252) -> ContractAddress {
    name.try_into().unwrap()
}

fn panel() -> Array<ContractAddress> {
    array![juror('ALICE'), juror('BOB'), juror('CAROL')]
}

#[derive(Drop, Copy)]
struct CommitteeMarket {
    veilcast: Veilcast,
    resolver: ICommitteeResolverDispatcher,
}

fn deploy_committee_market() -> CommitteeMarket {
    let veilcast = deploy_veilcast();
    let (resolver_address, _) = declare("CommitteeResolver")
        .unwrap()
        .contract_class()
        .deploy(@array![veilcast.market.contract_address.into()])
        .unwrap();
    CommitteeMarket {
        veilcast, resolver: ICommitteeResolverDispatcher { contract_address: resolver_address },
    }
}

#[generate_trait]
impl CommitteeMarketImpl of CommitteeMarketTrait {
    /// Opens a three-juror market needing `quorum` votes, closing at `CLOSE_AT`.
    fn open(self: @CommitteeMarket, quorum: u8) -> u64 {
        (*self.resolver)
            .open_committee_market(
                question: "Did the home team win?",
                outcome_labels: array!["Yes", "No"],
                close_at: CLOSE_AT,
                category: 'Sports',
                fee_bps: 0,
                jurors: panel(),
                :quorum,
            )
    }

    fn safe_resolver(self: @CommitteeMarket) -> ICommitteeResolverSafeDispatcher {
        ICommitteeResolverSafeDispatcher { contract_address: *self.resolver.contract_address }
    }

    /// Casts `who`'s vote for `choice`, cheating the caller so the resolver sees the juror.
    fn vote(self: @CommitteeMarket, market_id: u64, who: ContractAddress, choice: u8) {
        start_cheat_caller_address(*self.resolver.contract_address, who);
        (*self.resolver).vote(:market_id, :choice);
        stop_cheat_caller_address(*self.resolver.contract_address);
    }
}
#[test]
fn test_open_binds_the_panel_and_holds_the_resolver_role() {
    let committee = deploy_committee_market();

    let market_id = committee.open(quorum: 2);

    let market = committee.veilcast.market.get_market(market_id);
    assert_eq!(market.resolver, committee.resolver.contract_address);
    assert_eq!(market.n_outcomes, 2);
    assert_eq!(market.state, MarketState::Open);

    let bound = committee.resolver.get_committee(market_id);
    assert_eq!(
        bound,
        Committee { n_jurors: 3, quorum: 2, n_outcomes: 2, close_at: CLOSE_AT, decided: false },
    );
    assert!(committee.resolver.is_juror(market_id, juror('ALICE')));
    assert!(committee.resolver.is_juror(market_id, juror('BOB')));
    assert!(!committee.resolver.is_juror(market_id, juror('MALLORY')));
    assert_eq!(committee.resolver.get_market(), committee.veilcast.market.contract_address);
}

/// The whole point: no one address settles this. The quorum's worth of jurors agreeing is what
/// resolves the market, and the last voter is just whoever paid the gas.
#[test]
fn test_quorum_of_votes_settles_the_market() {
    let committee = deploy_committee_market();
    let market_id = committee.open(quorum: 2);
    let winner = new_coupon();
    committee
        .veilcast
        .bet(:market_id, outcome: 0, amount: ONE_STRK, position_key: winner.public_key);
    committee
        .veilcast
        .bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: new_coupon().public_key);
    start_cheat_block_timestamp_global(CLOSE_AT);

    // One vote is not a settlement.
    committee.vote(market_id, juror('ALICE'), 0);
    assert_eq!(committee.veilcast.market.get_market(market_id).state, MarketState::Open);
    assert_eq!(committee.resolver.get_votes(market_id, 0), 1);
    assert!(committee.resolver.has_voted(market_id, juror('ALICE')));
    assert_eq!(committee.resolver.vote_of(market_id, juror('ALICE')), 0);

    // The second vote for the same outcome reaches quorum and settles it in this transaction.
    committee.vote(market_id, juror('BOB'), 0);
    let settled = committee.veilcast.market.get_market(market_id);
    assert_eq!(settled.state, MarketState::Resolved);
    assert_eq!(settled.winning_outcome, 0);
    assert!(committee.resolver.get_committee(market_id).decided);

    // The winner collects the whole pot, exactly as with any other resolver.
    committee.veilcast.claim_to_note(:market_id, outcome: 0, coupon: winner, note_id: 'NOTE');
    assert_eq!(committee.veilcast.pool.get_note_amount('NOTE'), 2 * ONE_STRK);
}

/// A split panel that reaches quorum for void cancels the market, and every stake is refundable.
#[test]
fn test_quorum_for_void_cancels_the_market() {
    let committee = deploy_committee_market();
    let market_id = committee.open(quorum: 2);
    let alice = new_coupon();
    committee
        .veilcast
        .bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    start_cheat_block_timestamp_global(CLOSE_AT);

    committee.vote(market_id, juror('ALICE'), VOID_CHOICE);
    committee.vote(market_id, juror('BOB'), VOID_CHOICE);

    assert_eq!(committee.veilcast.market.get_market(market_id).state, MarketState::Void);
    committee.veilcast.claim_to_note(:market_id, outcome: 0, coupon: alice, note_id: 'NOTE');
    assert_eq!(committee.veilcast.pool.get_note_amount('NOTE'), 3 * ONE_STRK);
}
/// Voting is closed before the market is, refused to anyone off the panel, taken once per juror,
/// and refused for a choice the market does not have.
#[test]
#[feature("safe_dispatcher")]
fn test_vote_guards() {
    let committee = deploy_committee_market();
    let market_id = committee.open(quorum: 2);
    let resolver = committee.safe_resolver();

    // A juror this resolver never seated cannot vote, even before the timing is checked.
    start_cheat_caller_address(committee.resolver.contract_address, juror('MALLORY'));
    assert_panic(resolver.vote(market_id, 0), errors::NOT_A_JUROR);
    stop_cheat_caller_address(committee.resolver.contract_address);

    // A seated juror still cannot vote before the market closes.
    start_cheat_caller_address(committee.resolver.contract_address, juror('ALICE'));
    assert_panic(resolver.vote(market_id, 0), errors::VOTING_NOT_OPEN);
    stop_cheat_caller_address(committee.resolver.contract_address);

    start_cheat_block_timestamp_global(CLOSE_AT);

    // No such outcome, and no such market.
    start_cheat_caller_address(committee.resolver.contract_address, juror('ALICE'));
    assert_panic(resolver.vote(market_id, 2), errors::BAD_CHOICE);
    stop_cheat_caller_address(committee.resolver.contract_address);
    assert_panic(resolver.vote(7, 0), errors::NO_COMMITTEE);

    // A juror votes once and cannot vote again, even for a different choice.
    committee.vote(market_id, juror('ALICE'), 0);
    start_cheat_caller_address(committee.resolver.contract_address, juror('ALICE'));
    assert_panic(resolver.vote(market_id, 1), errors::ALREADY_VOTED);
    stop_cheat_caller_address(committee.resolver.contract_address);
}

/// Once the panel has decided, the market is settled and no late vote can touch it.
#[test]
#[feature("safe_dispatcher")]
fn test_no_vote_after_the_panel_decided() {
    let committee = deploy_committee_market();
    let market_id = committee.open(quorum: 2);
    committee
        .veilcast
        .bet(:market_id, outcome: 0, amount: ONE_STRK, position_key: new_coupon().public_key);
    start_cheat_block_timestamp_global(CLOSE_AT);
    committee.vote(market_id, juror('ALICE'), 0);
    committee.vote(market_id, juror('BOB'), 0);

    start_cheat_caller_address(committee.resolver.contract_address, juror('CAROL'));
    assert_panic(committee.safe_resolver().vote(market_id, 1), errors::ALREADY_DECIDED);
    stop_cheat_caller_address(committee.resolver.contract_address);
}

/// A quorum of one is a single trusted resolver, which the opener may choose, but zero, or more
/// than the whole panel, cannot be honoured. A jury has to have jurors, and none can sit twice.
#[test]
#[feature("safe_dispatcher")]
fn test_open_rejects_a_panel_that_cannot_work() {
    let committee = deploy_committee_market();
    let resolver = committee.safe_resolver();
    let open = |jurors: Array<ContractAddress>, quorum: u8| resolver
        .open_committee_market(
            question: "Q",
            outcome_labels: array!["Yes", "No"],
            close_at: CLOSE_AT,
            category: 'Sports',
            fee_bps: 0,
            :jurors,
            :quorum,
        );

    assert_panic(open(array![], 1), errors::TOO_FEW_JURORS);
    assert_panic(open(panel(), 0), errors::BAD_QUORUM);
    assert_panic(open(panel(), 4), errors::BAD_QUORUM);
    assert_panic(open(array![juror('ALICE'), juror('ALICE')], 1), errors::DUPLICATE_JUROR);
    assert_panic(open(array![juror('ALICE'), Zero::zero()], 1), errors::ZERO_JUROR);
    assert_eq!(committee.veilcast.market.get_n_markets(), 0);
}

/// A quorum of one lets a lone juror settle, for a panel that wants a fast single arbiter. The
/// opener chose it and a bettor saw it, so it is allowed.
#[test]
fn test_quorum_of_one_settles_on_a_single_vote() {
    let committee = deploy_committee_market();
    let market_id = committee
        .resolver
        .open_committee_market(
            question: "Q",
            outcome_labels: array!["Yes", "No"],
            close_at: CLOSE_AT,
            category: 'Sports',
            fee_bps: 0,
            jurors: array![juror('ALICE')],
            quorum: 1,
        );
    committee
        .veilcast
        .bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: new_coupon().public_key);
    start_cheat_block_timestamp_global(CLOSE_AT);

    committee.vote(market_id, juror('ALICE'), 1);
    assert_eq!(committee.veilcast.market.get_market(market_id).winning_outcome, 1);
}

/// A deadlocked panel cannot settle anything, so the market falls through to the public void every
/// market carries: 30 days past the close, anyone can cancel it and every stake refunds.
#[test]
fn test_a_deadlocked_panel_falls_through_to_the_public_void() {
    let committee = deploy_committee_market();
    let market_id = committee.open(quorum: 3);
    let alice = new_coupon();
    committee
        .veilcast
        .bet(:market_id, outcome: 0, amount: ONE_STRK, position_key: alice.public_key);
    start_cheat_block_timestamp_global(CLOSE_AT);

    // Every juror votes a different way, so no choice reaches three.
    committee.vote(market_id, juror('ALICE'), 0);
    committee.vote(market_id, juror('BOB'), 1);
    committee.vote(market_id, juror('CAROL'), VOID_CHOICE);
    assert_eq!(committee.veilcast.market.get_market(market_id).state, MarketState::Open);

    // The market's own rule takes over: 30 days on, anyone voids it.
    start_cheat_block_timestamp_global(CLOSE_AT + 2592000);
    committee.veilcast.market.void(market_id);
    assert_eq!(committee.veilcast.market.get_market(market_id).state, MarketState::Void);
    committee.veilcast.claim_to_note(:market_id, outcome: 0, coupon: alice, note_id: 'NOTE');
    assert_eq!(committee.veilcast.pool.get_note_amount('NOTE'), ONE_STRK);
}
