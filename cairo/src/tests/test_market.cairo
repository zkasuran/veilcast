use core::num::traits::Zero;
use snforge_std::signature::SignerTrait;
use snforge_std::signature::stark_curve::StarkCurveSignerImpl;
use snforge_std::{
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::{ContractAddress, get_block_timestamp};
use veilcast::interface::{
    BetInput, ClaimInput, IVeilcastMarketDispatcherTrait, IVeilcastMarketSafeDispatcher,
    IVeilcastMarketSafeDispatcherTrait, MarketAction, MarketState, PayoutTarget, errors,
};
use veilcast::market::{VOID_GRACE, claim_message_hash};
use veilcast::test_utils_contracts::mock_erc20::IMockErc20DispatcherTrait;
use veilcast::test_utils_contracts::mock_pool::IMockPoolDispatcherTrait;
use veilcast::tests::test_utils::{
    CouponKeyPair, ONE_STRK, TEST_CATEGORY, Veilcast, VeilcastTrait, assert_panic, deploy_veilcast,
    new_coupon,
};

const CLOSE_AT: u64 = 1000;

fn resolver_address() -> ContractAddress {
    'RESOLVER'.try_into().unwrap()
}

/// A safe dispatcher on the market, for the reverts a test wants to name.
fn safe_market(veilcast: @Veilcast) -> IVeilcastMarketSafeDispatcher {
    IVeilcastMarketSafeDispatcher { contract_address: *veilcast.market.contract_address }
}

/// Makes the market believe the pool is calling, which is the only way in for a bet or a claim.
fn cheat_pool_caller(veilcast: @Veilcast) {
    start_cheat_caller_address(*veilcast.market.contract_address, *veilcast.pool.contract_address);
}

#[test]
fn test_create_market_and_views() {
    let veilcast = deploy_veilcast();
    let resolver = resolver_address();

    let market_id = veilcast.create_binary_market(:resolver, close_at: CLOSE_AT);

    assert_eq!(market_id, 0);
    assert_eq!(veilcast.market.get_n_markets(), 1);
    let market = veilcast.market.get_market(market_id);
    assert_eq!(market.resolver, resolver);
    assert_eq!(market.close_at, CLOSE_AT);
    assert_eq!(market.category, TEST_CATEGORY);
    // Opened now, which is what lets a board sort by age without an indexer.
    assert_eq!(market.created_at, get_block_timestamp());
    assert_eq!(market.n_outcomes, 2);
    assert_eq!(market.state, MarketState::Open);
    assert_eq!(market.pot, 0);
    assert_eq!(veilcast.market.get_question(market_id), "Will STRK close above 1 USD?");
    assert_eq!(veilcast.market.get_outcome_label(market_id, 0), "Yes");
    assert_eq!(veilcast.market.get_outcome_label(market_id, 1), "No");
    let volumes = veilcast.market.get_outcome_volumes(market_id);
    assert_eq!(volumes.len(), 2);
    assert_eq!(*volumes.at(0), 0);
    assert_eq!(*volumes.at(1), 0);
    assert_eq!(veilcast.market.get_pool(), veilcast.pool.contract_address);
    assert_eq!(veilcast.market.get_token(), veilcast.token.contract_address);
    // Ids are handed out in sequence.
    assert_eq!(veilcast.create_binary_market(:resolver, close_at: CLOSE_AT), 1);
}

#[test]
#[feature("safe_dispatcher")]
fn test_create_market_rejects_bad_input() {
    let veilcast = deploy_veilcast();
    let market = safe_market(@veilcast);
    let resolver = resolver_address();

    assert_panic(
        market
            .create_market(
                question: "Q",
                outcome_labels: array!["Only one"],
                :resolver,
                close_at: CLOSE_AT,
                category: 'Crypto',
            ),
        errors::TOO_FEW_OUTCOMES,
    );
    assert_panic(
        market
            .create_market(
                question: "Q",
                outcome_labels: array!["1", "2", "3", "4", "5", "6", "7", "8", "9"],
                :resolver,
                close_at: CLOSE_AT,
                category: 'Crypto',
            ),
        errors::TOO_MANY_OUTCOMES,
    );
    assert_panic(
        market
            .create_market(
                question: "Q",
                outcome_labels: array!["Yes", "No"],
                resolver: Zero::zero(),
                close_at: CLOSE_AT,
                category: 'Crypto',
            ),
        errors::ZERO_RESOLVER,
    );
    assert_panic(
        market
            .create_market(
                question: "Q",
                outcome_labels: array!["Yes", "No"],
                :resolver,
                close_at: 0,
                category: 'Crypto',
            ),
        errors::CLOSE_IN_PAST,
    );
    assert_eq!(veilcast.market.get_n_markets(), 0);
}

#[test]
fn test_bet_records_volume_stake_and_escrow() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();
    let bob = new_coupon();

    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    veilcast.bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: bob.public_key);
    // One coupon betting the same outcome twice adds up.
    veilcast.bet(:market_id, outcome: 0, amount: 2 * ONE_STRK, position_key: alice.public_key);

    let volumes = veilcast.market.get_outcome_volumes(market_id);
    assert_eq!(*volumes.at(0), 5 * ONE_STRK);
    assert_eq!(*volumes.at(1), ONE_STRK);
    assert_eq!(veilcast.market.get_market(market_id).pot, 6 * ONE_STRK);
    assert_eq!(veilcast.market.get_stake(market_id, 0, alice.public_key), 5 * ONE_STRK);
    assert_eq!(veilcast.market.get_stake(market_id, 1, bob.public_key), ONE_STRK);
    // A coupon holds nothing on an outcome it never backed.
    assert_eq!(veilcast.market.get_stake(market_id, 1, alice.public_key), 0);
    assert_eq!(veilcast.market.get_total_escrow(), 6 * ONE_STRK);
    assert_eq!(veilcast.token.balance_of(veilcast.market.contract_address), (6 * ONE_STRK).into());
}

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_rejects_caller_other_than_pool() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);

    // No caller cheat: the test contract is not the pool, so there is no way to place this bet.
    assert_panic(
        safe_market(@veilcast)
            .privacy_invoke(
                MarketAction::Bet(
                    BetInput { market_id, outcome: 0, amount: ONE_STRK, position_key: 'COUPON' },
                ),
            ),
        errors::UNAUTHORIZED_CALLER,
    );
}

/// A bet is only credited for what actually arrived, so a caller cannot book a stake the pool
/// never withdrew. Surplus sent to the contract unasked backs a stake and nothing more.
#[test]
#[feature("safe_dispatcher")]
fn test_bet_rejects_stake_the_pool_did_not_fund() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let market = safe_market(@veilcast);
    let bet = |
        amount,
    | MarketAction::Bet(BetInput { market_id, outcome: 0, amount, position_key: 'COUPON' });
    cheat_pool_caller(@veilcast);

    // Nothing arrived at all.
    assert_panic(market.privacy_invoke(bet(ONE_STRK)), errors::STAKE_NOT_FUNDED);

    // One STRK arrived, so two cannot be booked, and the one that did is credited exactly once.
    veilcast.token.mint(recipient: veilcast.market.contract_address, amount: ONE_STRK.into());
    assert_panic(market.privacy_invoke(bet(2 * ONE_STRK)), errors::STAKE_NOT_FUNDED);
    market.privacy_invoke(bet(ONE_STRK)).unwrap();
    assert_eq!(veilcast.market.get_total_escrow(), ONE_STRK);
    assert_panic(market.privacy_invoke(bet(ONE_STRK)), errors::STAKE_NOT_FUNDED);

    stop_cheat_caller_address(veilcast.market.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_bet_guards() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let market = safe_market(@veilcast);
    // Fund the contract so every rejection below is about the bet, not about the money.
    veilcast.token.mint(recipient: veilcast.market.contract_address, amount: (9 * ONE_STRK).into());
    let bet = |
        market_id, outcome, amount, position_key,
    | MarketAction::Bet(BetInput { market_id, outcome, amount, position_key });
    cheat_pool_caller(@veilcast);

    assert_panic(market.privacy_invoke(bet(market_id, 2, ONE_STRK, 'K')), errors::NO_SUCH_OUTCOME);
    assert_panic(market.privacy_invoke(bet(market_id, 0, 0, 'K')), errors::ZERO_AMOUNT);
    assert_panic(market.privacy_invoke(bet(market_id, 0, ONE_STRK, 0)), errors::ZERO_POSITION_KEY);
    assert_panic(market.privacy_invoke(bet(7, 0, ONE_STRK, 'K')), errors::NO_MARKET);

    // Bets stop the moment the market closes.
    start_cheat_block_timestamp_global(CLOSE_AT);
    assert_panic(market.privacy_invoke(bet(market_id, 0, ONE_STRK, 'K')), errors::MARKET_CLOSED);

    stop_cheat_caller_address(veilcast.market.contract_address);
}

/// The whole path: three bets through the pool, a resolution, then both winners collecting into
/// open notes. Winners split the entire pot in proportion to their stake on the winning outcome.
#[test]
fn test_resolve_then_claim_pays_parimutuel_share_into_open_notes() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();
    let carol = new_coupon();
    let bob = new_coupon();
    let pool_balance_before = veilcast.token.balance_of(veilcast.pool.contract_address);

    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    veilcast.bet(:market_id, outcome: 0, amount: ONE_STRK, position_key: carol.public_key);
    veilcast.bet(:market_id, outcome: 1, amount: 2 * ONE_STRK, position_key: bob.public_key);

    start_cheat_block_timestamp_global(CLOSE_AT);
    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    veilcast.market.resolve(:market_id, winning_outcome: 0);
    stop_cheat_caller_address(veilcast.market.contract_address);

    let market = veilcast.market.get_market(market_id);
    assert_eq!(market.state, MarketState::Resolved);
    assert_eq!(market.winning_outcome, 0);
    assert_eq!(market.pot, 6 * ONE_STRK);

    // 3 of the 4 STRK on the winning outcome, so 3/4 of the 6 STRK pot.
    let alice_payout = 4_500_000_000_000_000_000;
    let deposits = veilcast
        .claim_to_note(:market_id, outcome: 0, coupon: alice, note_id: 'NOTE_ALICE');
    assert_eq!(deposits.len(), 1);
    let deposit = *deposits.at(0);
    assert_eq!(deposit.note_id, 'NOTE_ALICE');
    assert_eq!(deposit.token, veilcast.token.contract_address);
    assert_eq!(deposit.amount, alice_payout);
    assert_eq!(veilcast.pool.get_note_amount('NOTE_ALICE'), alice_payout);
    assert_eq!(veilcast.market.get_stake(market_id, 0, alice.public_key), 0);
    assert_eq!(veilcast.market.get_total_escrow(), 6 * ONE_STRK - alice_payout);

    let carol_payout = 1_500_000_000_000_000_000;
    veilcast.claim_to_note(:market_id, outcome: 0, coupon: carol, note_id: 'NOTE_CAROL');
    assert_eq!(veilcast.pool.get_note_amount('NOTE_CAROL'), carol_payout);

    // The pot is paid out to the last unit and the pool is whole again.
    assert_eq!(veilcast.market.get_total_escrow(), 0);
    assert_eq!(veilcast.token.balance_of(veilcast.market.contract_address), 0);
    assert_eq!(veilcast.token.balance_of(veilcast.pool.contract_address), pool_balance_before);
    // The loser's stake stays where it is, unclaimable.
    assert_eq!(veilcast.market.get_stake(market_id, 1, bob.public_key), 2 * ONE_STRK);
}

/// A coupon signature names where the payout may go, so a claim bound to an address cannot be
/// redirected, and a bearer claim only ever fills the open note in its own transaction.
#[test]
#[feature("safe_dispatcher")]
fn test_claim_signature_binds_the_payout_target() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();
    let thief: ContractAddress = 'THIEF'.try_into().unwrap();
    let alice_wallet: ContractAddress = 'ALICE_WALLET'.try_into().unwrap();

    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    veilcast.bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: new_coupon().public_key);
    start_cheat_block_timestamp_global(CLOSE_AT);
    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    veilcast.market.resolve(:market_id, winning_outcome: 0);
    stop_cheat_caller_address(veilcast.market.contract_address);

    let market = safe_market(@veilcast);
    let claim = |
        signature_r, signature_s, target,
    | MarketAction::Claim(
        ClaimInput {
            market_id, outcome: 0, position_key: alice.public_key, signature_r, signature_s, target,
        },
    );
    let sign_for = |target| alice
        .sign(
            claim_message_hash(
                market_address: veilcast.market.contract_address,
                :market_id,
                outcome: 0,
                position_key: alice.public_key,
                :target,
            ),
        )
        .unwrap();
    cheat_pool_caller(@veilcast);

    // Signed as bearer, so it cannot be turned into a payout to an address.
    let (bearer_r, bearer_s) = sign_for(0);
    assert_panic(
        market.privacy_invoke(claim(bearer_r, bearer_s, PayoutTarget::Address(thief))),
        errors::BAD_CLAIM_SIGNATURE,
    );
    // Signed for Alice's wallet, so nobody can point it at another address.
    let (bound_r, bound_s) = sign_for(alice_wallet.into());
    assert_panic(
        market.privacy_invoke(claim(bound_r, bound_s, PayoutTarget::Address(thief))),
        errors::BAD_CLAIM_SIGNATURE,
    );
    // A signature from anyone but the coupon holder is worthless.
    let (forged_r, forged_s) = new_coupon()
        .sign(
            claim_message_hash(
                market_address: veilcast.market.contract_address,
                :market_id,
                outcome: 0,
                position_key: alice.public_key,
                target: alice_wallet.into(),
            ),
        )
        .unwrap();
    assert_panic(
        market.privacy_invoke(claim(forged_r, forged_s, PayoutTarget::Address(alice_wallet))),
        errors::BAD_CLAIM_SIGNATURE,
    );

    // The one it was signed for goes through, and pays the whole pot to that address: the winning
    // side takes the losing side's stake with it, so nothing is left escrowed.
    market.privacy_invoke(claim(bound_r, bound_s, PayoutTarget::Address(alice_wallet))).unwrap();
    assert_eq!(veilcast.token.balance_of(alice_wallet), (4 * ONE_STRK).into());
    assert_eq!(veilcast.market.get_total_escrow(), 0);
    assert_eq!(veilcast.token.balance_of(veilcast.market.contract_address), 0);
    stop_cheat_caller_address(veilcast.market.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_claim_guards() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();
    let bob = new_coupon();
    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    veilcast.bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: bob.public_key);
    let market = safe_market(@veilcast);
    let claim = |outcome, coupon: CouponKeyPair| {
        let (signature_r, signature_s) = coupon
            .sign(
                claim_message_hash(
                    market_address: veilcast.market.contract_address,
                    :market_id,
                    :outcome,
                    position_key: coupon.public_key,
                    target: 0,
                ),
            )
            .unwrap();
        MarketAction::Claim(
            ClaimInput {
                market_id,
                outcome,
                position_key: coupon.public_key,
                signature_r,
                signature_s,
                target: PayoutTarget::OpenNote('NOTE'),
            },
        )
    };
    cheat_pool_caller(@veilcast);

    // Nothing is claimable before the market settles.
    assert_panic(market.privacy_invoke(claim(0, alice)), errors::MARKET_UNSETTLED);
    // A coupon nobody staked has nothing to collect.
    assert_panic(market.privacy_invoke(claim(0, new_coupon())), errors::NO_POSITION);

    start_cheat_block_timestamp_global(CLOSE_AT);
    stop_cheat_caller_address(veilcast.market.contract_address);
    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    veilcast.market.resolve(:market_id, winning_outcome: 0);
    stop_cheat_caller_address(veilcast.market.contract_address);
    cheat_pool_caller(@veilcast);

    // The losing side cannot claim, and a winning coupon pays exactly once.
    assert_panic(market.privacy_invoke(claim(1, bob)), errors::LOSING_POSITION);
    market.privacy_invoke(claim(0, alice)).unwrap();
    assert_panic(market.privacy_invoke(claim(0, alice)), errors::NO_POSITION);
    stop_cheat_caller_address(veilcast.market.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_resolve_guards() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    veilcast.bet(:market_id, outcome: 0, amount: ONE_STRK, position_key: new_coupon().public_key);
    let market = safe_market(@veilcast);

    // Anyone but the named resolver is refused, whatever the timing.
    assert_panic(market.resolve(:market_id, winning_outcome: 0), errors::NOT_RESOLVER);

    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    // Not before the market closes.
    assert_panic(market.resolve(:market_id, winning_outcome: 0), errors::MARKET_NOT_CLOSED);
    start_cheat_block_timestamp_global(CLOSE_AT);
    assert_panic(market.resolve(:market_id, winning_outcome: 2), errors::NO_SUCH_OUTCOME);
    assert_panic(market.resolve(market_id: 9, winning_outcome: 0), errors::NO_MARKET);
    market.resolve(:market_id, winning_outcome: 0).unwrap();
    // And only once.
    assert_panic(market.resolve(:market_id, winning_outcome: 0), errors::MARKET_SETTLED);
    stop_cheat_caller_address(veilcast.market.contract_address);
}

/// A winning outcome nobody backed would strand the pot, so the market voids instead and every
/// stake becomes refundable.
#[test]
fn test_resolve_on_unbacked_outcome_voids_the_market() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();
    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);

    start_cheat_block_timestamp_global(CLOSE_AT);
    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    veilcast.market.resolve(:market_id, winning_outcome: 1);
    stop_cheat_caller_address(veilcast.market.contract_address);

    assert_eq!(veilcast.market.get_market(market_id).state, MarketState::Void);
    assert_eq!(veilcast.market.quote_payout(market_id, 0, 3 * ONE_STRK), 3 * ONE_STRK);
    veilcast.claim_to_note(:market_id, outcome: 0, coupon: alice, note_id: 'NOTE_ALICE');
    assert_eq!(veilcast.pool.get_note_amount('NOTE_ALICE'), 3 * ONE_STRK);
    assert_eq!(veilcast.market.get_total_escrow(), 0);
}

/// A void refunds every stake exactly, on both sides of the book.
#[test]
fn test_void_refunds_every_stake() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();
    let bob = new_coupon();
    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    veilcast.bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: bob.public_key);

    // The resolver may void an unsettled market at any time, closed or not.
    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    veilcast.market.void(market_id);
    stop_cheat_caller_address(veilcast.market.contract_address);

    assert_eq!(veilcast.market.get_market(market_id).state, MarketState::Void);
    veilcast.claim_to_note(:market_id, outcome: 0, coupon: alice, note_id: 'NOTE_ALICE');
    veilcast.claim_to_note(:market_id, outcome: 1, coupon: bob, note_id: 'NOTE_BOB');
    assert_eq!(veilcast.pool.get_note_amount('NOTE_ALICE'), 3 * ONE_STRK);
    assert_eq!(veilcast.pool.get_note_amount('NOTE_BOB'), ONE_STRK);
    assert_eq!(veilcast.market.get_total_escrow(), 0);
    assert_eq!(veilcast.token.balance_of(veilcast.market.contract_address), 0);
}

/// A resolver who goes silent cannot lock the pot: anyone may void the market once the grace
/// period past its close has elapsed, and not a second before.
#[test]
#[feature("safe_dispatcher")]
fn test_anyone_can_void_a_market_left_open_past_the_grace_period() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    veilcast.bet(:market_id, outcome: 0, amount: ONE_STRK, position_key: new_coupon().public_key);
    let market = safe_market(@veilcast);

    start_cheat_block_timestamp_global(CLOSE_AT + VOID_GRACE - 1);
    assert_panic(market.void(market_id), errors::VOID_TOO_EARLY);

    start_cheat_block_timestamp_global(CLOSE_AT + VOID_GRACE);
    market.void(market_id).unwrap();
    assert_eq!(veilcast.market.get_market(market_id).state, MarketState::Void);
}

/// The board is one call: every market in the range with its question, its labels and its live
/// volumes. A range past the last market is clipped, so paging never has to race `get_n_markets`.
#[test]
fn test_market_views_render_the_whole_board() {
    let veilcast = deploy_veilcast();
    let resolver = resolver_address();
    let market_id = veilcast.create_binary_market(:resolver, close_at: CLOSE_AT);
    veilcast.create_binary_market(:resolver, close_at: CLOSE_AT);
    veilcast
        .bet(:market_id, outcome: 1, amount: 2 * ONE_STRK, position_key: new_coupon().public_key);

    let views = veilcast.market.get_market_views(0, 8);

    assert_eq!(views.len(), 2);
    let view = views.at(0);
    assert_eq!(*view.market_id, market_id);
    assert_eq!(view.question, @"Will STRK close above 1 USD?");
    assert_eq!(view.outcome_labels, @array!["Yes", "No"]);
    assert_eq!(view.outcome_volumes, @array![0, 2 * ONE_STRK]);
    assert_eq!(view.market.pot, @(2 * ONE_STRK));
    assert_eq!(view.market.state, @MarketState::Open);
    assert_eq!(view.market.resolver, @resolver);
    assert_eq!(view.market.category, @TEST_CATEGORY);
    assert_eq!(*views.at(1).market_id, 1);

    // A window inside the board, and one that runs off the end.
    let window = veilcast.market.get_market_views(1, 1);
    assert_eq!(window.len(), 1);
    assert_eq!(*window.at(0).market_id, 1);
    assert_eq!(veilcast.market.get_market_views(1, 99).len(), 1);
    // Nothing past the last market, and no panic for asking.
    assert_eq!(veilcast.market.get_market_views(2, 5).len(), 0);
    assert_eq!(veilcast.market.get_market_views(0, 0).len(), 0);
}

/// The frontend signs claims with its own Poseidon implementation, so the two have to agree felt
/// for felt. This is the fixed vector `src/utils/veilcast.test.ts` checks on the TypeScript side:
/// if either implementation drifts, one of the two tests fails.
#[test]
fn test_claim_message_hash_matches_the_frontend() {
    assert_eq!(
        claim_message_hash(
            market_address: 'MARKET'.try_into().unwrap(),
            market_id: 7,
            outcome: 1,
            position_key: 'COUPON',
            target: 0,
        ),
        0x421e0ee22d66877400410f3d00e57cae3b41f27c631bb8315168ac53a23ddf6,
    );
}

/// The live quote is what the UI shows as odds: what a fresh stake would collect if its outcome
/// won, counting itself in both the pot and the winning side.
#[test]
fn test_quote_payout_tracks_the_book() {
    let veilcast = deploy_veilcast();
    let market_id = veilcast.create_binary_market(resolver: resolver_address(), close_at: CLOSE_AT);
    let alice = new_coupon();

    // Empty book: a stake can only ever win itself back.
    assert_eq!(veilcast.market.quote_payout(market_id, 0, ONE_STRK), ONE_STRK);

    veilcast.bet(:market_id, outcome: 0, amount: 3 * ONE_STRK, position_key: alice.public_key);
    veilcast.bet(:market_id, outcome: 1, amount: ONE_STRK, position_key: new_coupon().public_key);

    // 1 more STRK on Yes: a 5 STRK pot split over 4 STRK of Yes stake pays 1.25 back.
    assert_eq!(veilcast.market.quote_payout(market_id, 0, ONE_STRK), 1_250_000_000_000_000_000);
    // The thin side pays more: a 5 STRK pot over 2 STRK of No stake pays 2.5.
    assert_eq!(veilcast.market.quote_payout(market_id, 1, ONE_STRK), 2_500_000_000_000_000_000);

    start_cheat_block_timestamp_global(CLOSE_AT);
    start_cheat_caller_address(veilcast.market.contract_address, resolver_address());
    veilcast.market.resolve(:market_id, winning_outcome: 0);
    stop_cheat_caller_address(veilcast.market.contract_address);

    // Settled, so the quote is the real share of the 4 STRK pot: 3/3 of it for Alice's 3 STRK.
    assert_eq!(veilcast.market.quote_payout(market_id, 0, 3 * ONE_STRK), 4 * ONE_STRK);
    // The losing side is worth nothing.
    assert_eq!(veilcast.market.quote_payout(market_id, 1, ONE_STRK), 0);
}
