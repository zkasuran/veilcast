//! Lifecycle and solvency tests for the leveraged market: LP funding, market creation, opening
//! a leveraged position through the pool, closing it with the bearer signature, keeper
//! liquidation of an under-margined position, and the balance invariant that keeps the contract
//! solvent no matter what.

use core::poseidon::poseidon_hash_span;
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veilcast::interface::PayoutTarget;
use veilcast::leverage_interface::{
    AgentCloseInput, CLOSE_MESSAGE_TAG, CloseInput, ILeveragedMarketDispatcher,
    ILeveragedMarketDispatcherTrait, ILeveragedMarketSafeDispatcher,
    ILeveragedMarketSafeDispatcherTrait, LeverageAction, Mandate, OpenInput, PositionState, SIDE_NO,
    SIDE_YES, no_mandate,
};
use veilcast::leveraged_market::close_message_hash;
use veilcast::test_utils_contracts::mock_erc20::{IMockErc20Dispatcher, IMockErc20DispatcherTrait};

const ONE: u128 = 1_000_000_000_000_000_000;

fn POOL() -> ContractAddress {
    'POOL'.try_into().unwrap()
}
fn LP() -> ContractAddress {
    'LP'.try_into().unwrap()
}
fn KEEPER() -> ContractAddress {
    'KEEPER'.try_into().unwrap()
}
fn RESOLVER() -> ContractAddress {
    'RESOLVER'.try_into().unwrap()
}
fn PAYEE() -> ContractAddress {
    'PAYEE'.try_into().unwrap()
}

#[derive(Drop, Copy)]
struct Env {
    token: IMockErc20Dispatcher,
    lev: ILeveragedMarketDispatcher,
    lev_addr: ContractAddress,
}

fn setup() -> Env {
    let (token_addr, _) = declare("MockErc20").unwrap().contract_class().deploy(@array![]).unwrap();
    let (lev_addr, _) = declare("LeveragedMarket")
        .unwrap()
        .contract_class()
        .deploy(@array![POOL().into(), token_addr.into()])
        .unwrap();
    Env {
        token: IMockErc20Dispatcher { contract_address: token_addr },
        lev: ILeveragedMarketDispatcher { contract_address: lev_addr },
        lev_addr,
    }
}

fn add_lp(env: Env, amount: u128) {
    env.token.mint(LP(), amount.into());
    start_cheat_caller_address(env.token.contract_address, LP());
    env.token.approve(env.lev_addr, amount.into());
    stop_cheat_caller_address(env.token.contract_address);
    start_cheat_caller_address(env.lev_addr, LP());
    env.lev.add_liquidity(amount);
    stop_cheat_caller_address(env.lev_addr);
}

fn create_market(env: Env, liquidity: u128, close_at: u64) -> u64 {
    start_cheat_caller_address(env.lev_addr, LP());
    let id = env.lev.create_market(RESOLVER(), close_at, liquidity);
    stop_cheat_caller_address(env.lev_addr);
    id
}

fn pool_open(env: Env, market_id: u64, side: u8, key: felt252, margin: u128, leverage_bps: u32) {
    env.token.mint(env.lev_addr, margin.into()); // the pool withdraws margin in, then invokes
    start_cheat_caller_address(env.lev_addr, POOL());
    env
        .lev
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id,
                    side,
                    position_key: key,
                    margin,
                    leverage_bps,
                    max_price_bps: 10000,
                    mandate: no_mandate(),
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
}

fn pool_close(
    env: Env, kp: KeyPair<felt252, felt252>, market_id: u64, side: u8, recipient: ContractAddress,
) {
    let target: felt252 = recipient.into();
    let msg = poseidon_hash_span(
        array![
            CLOSE_MESSAGE_TAG, env.lev_addr.into(), market_id.into(), side.into(), kp.public_key,
            target,
        ]
            .span(),
    );
    let (r, s) = kp.sign(msg).unwrap();
    start_cheat_caller_address(env.lev_addr, POOL());
    env
        .lev
        .privacy_invoke(
            LeverageAction::Close(
                CloseInput {
                    market_id,
                    side,
                    position_key: kp.public_key,
                    signature_r: r,
                    signature_s: s,
                    target: PayoutTarget::Address(recipient),
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
}

/// The contract can never owe more than it holds.
fn assert_solvent(env: Env) {
    let bal = env.token.balance_of(env.lev_addr);
    let oblig: u256 = env.lev.get_vault_free().into()
        + env.lev.get_total_backing().into()
        + env.lev.get_insurance().into();
    assert(bal >= oblig, 'INSOLVENT');
}

#[test]
fn lp_market_and_price() {
    let env = setup();
    add_lp(env, 1000 * ONE);
    let id = create_market(env, 200 * ONE, 9999999999);
    assert(id == 0, 'first id 0');
    assert(env.lev.price_bps(0, SIDE_YES) == 5000, 'even price');
    assert(env.lev.get_vault_free() == 800 * ONE, 'free 800');
    assert(env.lev.get_total_backing() == 200 * ONE, 'backing 200');
    assert_solvent(env);
}

#[test]
fn open_records_and_moves_price() {
    let env = setup();
    add_lp(env, 1000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, kp.public_key, 100 * ONE, 30000); // 3x
    let p = env.lev.get_position(0, SIDE_YES, kp.public_key);
    assert(p.state == PositionState::Open, 'open');
    assert(p.margin == 100 * ONE, 'margin 100');
    assert(p.borrowed == 200 * ONE, 'borrowed 200');
    assert(p.shares > 0, 'has shares');
    assert(env.lev.price_bps(0, SIDE_YES) > 5000, 'yes up');
    assert(env.lev.get_vault_free() == 600 * ONE, 'lent 200');
    assert_solvent(env);
}

#[test]
fn close_roundtrip_pays_and_repays() {
    let env = setup();
    add_lp(env, 1000 * ONE);
    create_market(env, 500 * ONE, 9999999999);
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, kp.public_key, 100 * ONE, 20000); // 2x
    let free_after_open = env.lev.get_vault_free();
    pool_close(env, kp, 0, SIDE_YES, PAYEE());
    let p = env.lev.get_position(0, SIDE_YES, kp.public_key);
    assert(p.state == PositionState::Closed, 'closed');
    assert(env.lev.get_vault_free() >= free_after_open + 100 * ONE, 'loan repaid');
    assert(env.token.balance_of(PAYEE()) > 0, 'equity paid');
    assert_solvent(env);
}

#[test]
fn keeper_liquidates_underwater_position() {
    let env = setup();
    add_lp(env, 3000 * ONE);
    create_market(env, 100 * ONE, 9999999999);
    // A 5x long YES.
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, kp.public_key, 40 * ONE, 50000);
    // A large opposite (long NO) open crashes the YES price far below the long's entry.
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_NO, whale.public_key, 300 * ONE, 50000);
    // The YES position is now deep underwater; a keeper can liquidate it.
    let (_, _, health) = env.lev.position_equity(0, SIDE_YES, kp.public_key);
    assert(health <= 800, 'unhealthy');
    start_cheat_caller_address(env.lev_addr, KEEPER());
    env.lev.liquidate(0, SIDE_YES, kp.public_key);
    stop_cheat_caller_address(env.lev_addr);
    let p = env.lev.get_position(0, SIDE_YES, kp.public_key);
    assert(p.state == PositionState::Liquidated, 'liquidated');
    assert_solvent(env);
}

#[test]
#[feature("safe_dispatcher")]
fn privacy_invoke_is_pool_only() {
    let env = setup();
    add_lp(env, 1000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    // Caller is not the pool (default test address), so privacy_invoke must revert.
    let result = safe
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: kp.public_key,
                    margin: 10 * ONE,
                    leverage_bps: 20000,
                    max_price_bps: 10000,
                    mandate: no_mandate(),
                },
            ),
        );
    match result {
        Result::Ok(_) => panic!("expected pool-only revert"),
        Result::Err(data) => assert(*data.at(0) == 'UNAUTHORIZED_CALLER', 'wrong err'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn open_rejects_over_max_leverage() {
    let env = setup();
    add_lp(env, 1000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    env.token.mint(env.lev_addr, (10 * ONE).into());
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: kp.public_key,
                    margin: 10 * ONE,
                    leverage_bps: 60000, // 6x, over the 5x cap
                    max_price_bps: 10000,
                    mandate: no_mandate(),
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("expected leverage cap revert"),
        Result::Err(data) => assert(*data.at(0) == 'BAD_LEVERAGE', 'wrong err'),
    }
}
// Map a fuzzer word into `[lo, lo + span)`, so a random u128 becomes a usable margin.
fn bounded_u128(x: u128, lo: u128, span: u128) -> u128 {
    lo + x % span
}

/// Sign the same target-bound close message the owner would, with whatever key is handed in. Used
/// to drive the agent path and to prove a wrong key cannot.
fn sign_close(
    env: Env,
    kp: KeyPair<felt252, felt252>,
    market_id: u64,
    side: u8,
    position_key: felt252,
    target: felt252,
) -> (felt252, felt252) {
    kp.sign(close_message_hash(env.lev_addr, market_id, side, position_key, target)).unwrap()
}

fn pool_agent_close(
    env: Env,
    agent: KeyPair<felt252, felt252>,
    market_id: u64,
    side: u8,
    position_key: felt252,
    target: ContractAddress,
) {
    let (r, s) = sign_close(env, agent, market_id, side, position_key, target.into());
    start_cheat_caller_address(env.lev_addr, POOL());
    env
        .lev
        .privacy_invoke(
            LeverageAction::AgentClose(
                AgentCloseInput { market_id, side, position_key, signature_r: r, signature_s: s },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
}

/// Open a position on either side, at any size, carrying a mandate. Returns the owner and agent
/// keypairs. The flexible form behind `open_with_mandate`, used by the adversarial fuzz.
fn open_with_mandate_at(
    env: Env,
    side: u8,
    margin: u128,
    leverage_bps: u32,
    stop_price_bps: u16,
    take_price_bps: u16,
    target: ContractAddress,
) -> (KeyPair<felt252, felt252>, KeyPair<felt252, felt252>) {
    let owner = KeyPairTrait::<felt252, felt252>::generate();
    let agent = KeyPairTrait::<felt252, felt252>::generate();
    env.token.mint(env.lev_addr, margin.into());
    start_cheat_caller_address(env.lev_addr, POOL());
    env
        .lev
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id: 0,
                    side,
                    position_key: owner.public_key,
                    margin,
                    leverage_bps,
                    max_price_bps: 10000,
                    mandate: Mandate {
                        agent_key: agent.public_key,
                        stop_price_bps,
                        take_price_bps,
                        payout_target: target,
                    },
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    (owner, agent)
}

/// Open a 2x long YES carrying a mandate. Returns the owner and agent keypairs.
fn open_with_mandate(
    env: Env, stop_price_bps: u16, take_price_bps: u16,
) -> (KeyPair<felt252, felt252>, KeyPair<felt252, felt252>) {
    open_with_mandate_at(env, SIDE_YES, 50 * ONE, 20000, stop_price_bps, take_price_bps, PAYEE())
}

/// The whole point of a mandate: an agent fires the owner's take-profit once the market reaches it,
/// and the money still goes to the address the owner pinned at open, not anywhere the agent chose.
#[test]
fn agent_fires_the_take_profit_and_pays_the_pinned_address() {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let (owner, agent) = open_with_mandate(env, 0, 6000);
    // Another long YES pushes the price up through the take, so the position is in profit.
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, whale.public_key, 200 * ONE, 50000);
    assert(env.lev.price_bps(0, SIDE_YES) >= 6000, 'take reached');
    let before = env.token.balance_of(PAYEE());
    pool_agent_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE());
    let p = env.lev.get_position(0, SIDE_YES, owner.public_key);
    assert(p.state == PositionState::Closed, 'closed by agent');
    // The owner's pinned address collected, at a profit over the 50 STRK margin it posted.
    assert(env.token.balance_of(PAYEE()) > before + (50 * ONE).into(), 'owner paid a profit');
    assert_solvent(env);
}

/// A stop is the other half: the agent exits a losing position once it breaches the floor the owner
/// set, capping the loss rather than waiting for a keeper to liquidate it. Equity is thin by then,
/// which is the point, so this asserts the exit and the solvency rather than a payout.
#[test]
fn agent_fires_the_stop_to_cap_a_loss() {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let (owner, agent) = open_with_mandate(env, 4800, 0);
    // A large long NO crashes the YES price through the stop.
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_NO, whale.public_key, 200 * ONE, 50000);
    assert(env.lev.price_bps(0, SIDE_YES) <= 4800, 'stop reached');
    pool_agent_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE());
    let p = env.lev.get_position(0, SIDE_YES, owner.public_key);
    assert(p.state == PositionState::Closed, 'stopped out');
    assert_solvent(env);
}

/// An agent holding a valid key still cannot act before the market reaches the band it was granted.
/// This is what keeps a compromised agent key from being a liquidation button.
#[test]
#[feature("safe_dispatcher")]
fn agent_cannot_close_outside_its_band() {
    let env = setup();
    add_lp(env, 3000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    // A stop far below the current price, so the mandate is not met.
    let (owner, agent) = open_with_mandate(env, 1000, 0);
    let (r, s) = sign_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE().into());
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::AgentClose(
                AgentCloseInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    signature_r: r,
                    signature_s: s,
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("expected mandate-not-met revert"),
        Result::Err(data) => assert(*data.at(0) == 'MANDATE_NOT_MET', 'wrong err'),
    }
    assert(
        env.lev.get_position(0, SIDE_YES, owner.public_key).state == PositionState::Open, 'open',
    );
}

/// A stranger cannot invent an agent. The owner's own signature is not valid on the agent path,
/// so neither key can be replayed as the other.
#[test]
#[feature("safe_dispatcher")]
fn agent_close_rejects_a_key_it_was_not_given() {
    let env = setup();
    add_lp(env, 3000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let (owner, _agent) = open_with_mandate(env, 5200, 0);
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_NO, whale.public_key, 200 * ONE, 50000); // band is now met
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    // The owner signs a perfectly good owner-close message; on the agent path it is worthless,
    // because the contract verifies against the mandate's agent key.
    let (r, s) = sign_close(env, owner, 0, SIDE_YES, owner.public_key, PAYEE().into());
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::AgentClose(
                AgentCloseInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    signature_r: r,
                    signature_s: s,
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("expected bad-signature revert"),
        Result::Err(data) => assert(*data.at(0) == 'BAD_CLOSE_SIGNATURE', 'wrong err'),
    }
}

/// A self-managed position has no mandate, so the agent path is closed to everyone, whatever they
/// sign. Delegation is opt-in per position.
#[test]
#[feature("safe_dispatcher")]
fn a_self_managed_position_admits_no_agent() {
    let env = setup();
    add_lp(env, 1000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, kp.public_key, 10 * ONE, 20000); // opened with no_mandate()
    let stranger = KeyPairTrait::<felt252, felt252>::generate();
    let (r, s) = sign_close(env, stranger, 0, SIDE_YES, kp.public_key, PAYEE().into());
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::AgentClose(
                AgentCloseInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: kp.public_key,
                    signature_r: r,
                    signature_s: s,
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("expected no-mandate revert"),
        Result::Err(data) => assert(*data.at(0) == 'NO_MANDATE', 'wrong err'),
    }
}

/// The owner keeps full control of a position it delegated: the agent is an extra hand, never a
/// replacement, so an owner close still works while a mandate is live.
#[test]
fn the_owner_can_still_close_a_delegated_position() {
    let env = setup();
    add_lp(env, 3000 * ONE);
    create_market(env, 500 * ONE, 9999999999);
    let (owner, _agent) = open_with_mandate(env, 4000, 9000);
    pool_close(env, owner, 0, SIDE_YES, PAYEE());
    assert(
        env.lev.get_position(0, SIDE_YES, owner.public_key).state == PositionState::Closed,
        'owner closed it',
    );
    assert_solvent(env);
}

/// The mandate a position carries is public, so an owner (or anyone auditing) can read exactly what
/// authority was granted rather than trusting the agent's word for it.
#[test]
fn a_mandate_is_readable_on_chain() {
    let env = setup();
    add_lp(env, 3000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let (owner, agent) = open_with_mandate(env, 4200, 8800);
    let m = env.lev.get_mandate(0, SIDE_YES, owner.public_key);
    assert(m.agent_key == agent.public_key, 'agent key');
    assert(m.stop_price_bps == 4200, 'stop');
    assert(m.take_price_bps == 8800, 'take');
    assert(m.payout_target == PAYEE(), 'target pinned');
}

/// The fixed vector the SDK and the app also pin. Three independent implementations, one number: if
/// the close-signature layout drifts in any of them, a test fails here instead of every close
/// reverting on-chain with a bad signature.
#[test]
fn test_close_message_hash_matches_the_frontend() {
    assert_eq!(
        close_message_hash(
            lev_address: 'LEV'.try_into().unwrap(),
            market_id: 7,
            side: 1,
            position_key: 'COUPON',
            target: 0,
        ),
        0x1b63599a3692bd03b2fb7691332e685cffb4bb5217293a435bf23f2c4790e8e,
    );
}

/// Open a position at a fuzzed margin, leverage and side, then close it straight back. The
/// contract must stay solvent throughout, the vault must lend exactly `borrowed`, and an
/// immediate solo close must repay the loan in full so the vault is no worse off than before.
#[test]
#[fuzzer(runs: 24)]
fn fuzz_open_then_close_keeps_the_vault_whole(margin_raw: u128, lev_raw: u32, side_raw: u8) {
    let env = setup();
    add_lp(env, 100000 * ONE);
    create_market(env, 1000 * ONE, 9999999999);
    let margin = bounded_u128(margin_raw, ONE, 50 * ONE);
    let lev = 10000 + lev_raw % 40001; // [1x, 5x]
    let side = side_raw % 2;
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    let free_before = env.lev.get_vault_free();
    pool_open(env, 0, side, kp.public_key, margin, lev);
    let p = env.lev.get_position(0, side, kp.public_key);
    assert(p.state == PositionState::Open, 'open');
    assert(env.lev.get_vault_free() == free_before - p.borrowed, 'lent exactly borrowed');
    assert_solvent(env);
    pool_close(env, kp, 0, side, PAYEE());
    assert(env.lev.get_position(0, side, kp.public_key).state == PositionState::Closed, 'closed');
    assert(env.lev.get_vault_free() >= free_before, 'vault made whole');
    assert_solvent(env);
}

/// Two traders on opposite sides at fuzzed margins never break the balance invariant, opening or
/// closing in either order.
#[test]
#[fuzzer(runs: 24)]
fn fuzz_two_opposite_positions_stay_solvent(m1_raw: u128, m2_raw: u128, lev_raw: u32) {
    let env = setup();
    add_lp(env, 100000 * ONE);
    create_market(env, 1000 * ONE, 9999999999);
    let m1 = bounded_u128(m1_raw, ONE, 40 * ONE);
    let m2 = bounded_u128(m2_raw, ONE, 40 * ONE);
    let lev = 10000 + lev_raw % 40001;
    let a = KeyPairTrait::<felt252, felt252>::generate();
    let b = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, a.public_key, m1, lev);
    assert_solvent(env);
    pool_open(env, 0, SIDE_NO, b.public_key, m2, lev);
    assert_solvent(env);
    pool_close(env, a, 0, SIDE_YES, PAYEE());
    assert_solvent(env);
    pool_close(env, b, 0, SIDE_NO, PAYEE());
    assert_solvent(env);
}

/// A fuzzed 5x long is crashed by a dominating whale on the other side, then liquidated. However
/// deep the bad debt, the keeper path never leaves the contract owing more than it holds.
#[test]
#[fuzzer(runs: 24)]
fn fuzz_liquidation_of_a_crashed_long_stays_solvent(margin_raw: u128) {
    let env = setup();
    add_lp(env, 100000 * ONE);
    create_market(env, 100 * ONE, 9999999999);
    let margin = bounded_u128(margin_raw, ONE, 50 * ONE);
    let kp = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, kp.public_key, margin, 50000); // 5x long YES
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_NO, whale.public_key, 500 * ONE, 50000); // crashes YES
    assert_solvent(env);
    let (_, _, health) = env.lev.position_equity(0, SIDE_YES, kp.public_key);
    assert(health <= 800, 'should be underwater');
    start_cheat_caller_address(env.lev_addr, KEEPER());
    env.lev.liquidate(0, SIDE_YES, kp.public_key);
    stop_cheat_caller_address(env.lev_addr);
    let liq = env.lev.get_position(0, SIDE_YES, kp.public_key);
    assert(liq.state == PositionState::Liquidated, 'liquidated');
    assert_solvent(env);
}

/// The security claim the whole agentic layer rests on, hammered rather than asserted: whatever key
/// an attacker brings, if it is not the mandate's agent key the close is refused. A fresh random
/// key per run stands in for every key an attacker could hold.
#[test]
#[fuzzer(runs: 40)]
#[feature("safe_dispatcher")]
fn fuzz_a_stranger_key_never_closes_a_mandated_position(seed: u128) {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    // A band that is already met, so the ONLY thing standing between the attacker and the money is
    // the signature check.
    let (owner, _agent) = open_with_mandate(env, 0, 5000);
    let stranger = KeyPairTrait::<felt252, felt252>::generate();
    // Vary which target the attacker signs over, to prove none of them help.
    let target: felt252 = if seed % 2 == 0 {
        PAYEE().into()
    } else {
        KEEPER().into()
    };
    let (r, s) = sign_close(env, stranger, 0, SIDE_YES, owner.public_key, target);
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::AgentClose(
                AgentCloseInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    signature_r: r,
                    signature_s: s,
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("a stranger key closed a mandated position"),
        Result::Err(data) => assert(*data.at(0) == 'BAD_CLOSE_SIGNATURE', 'wrong err'),
    }
    assert(
        env.lev.get_position(0, SIDE_YES, owner.public_key).state == PositionState::Open, 'open',
    );
    assert_solvent(env);
}

/// An agent holding the real key still cannot act at a price outside its band. The band is fuzzed
/// well away from the opening price, so every run is a legitimate agent asking too early.
#[test]
#[fuzzer(runs: 40)]
#[feature("safe_dispatcher")]
fn fuzz_the_real_agent_cannot_act_outside_its_band(stop_raw: u16) {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    // Stops in [1, 2000]: far below the even 5000 the book opens at, so the stop is never met.
    let stop = 1 + stop_raw % 2000;
    let (owner, agent) = open_with_mandate(env, stop, 0);
    assert(env.lev.price_bps(0, SIDE_YES) > stop, 'band not met');
    let (r, s) = sign_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE().into());
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::AgentClose(
                AgentCloseInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    signature_r: r,
                    signature_s: s,
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("agent acted outside its band"),
        Result::Err(data) => assert(*data.at(0) == 'MANDATE_NOT_MET', 'wrong err'),
    }
    assert(
        env.lev.get_position(0, SIDE_YES, owner.public_key).state == PositionState::Open, 'open',
    );
}

/// The payout address is the one pinned at open, whoever fires the mandate and whatever they would
/// rather it were. The attacker in this test IS the agent and it still cannot move the money: it
/// names no target, because the contract reads the target from storage.
#[test]
#[fuzzer(runs: 40)]
fn fuzz_an_agent_close_always_pays_the_pinned_target(margin_raw: u128) {
    let env = setup();
    add_lp(env, 20000 * ONE);
    create_market(env, 500 * ONE, 9999999999);
    let margin = bounded_u128(margin_raw, ONE, 100 * ONE);
    let (owner, agent) = open_with_mandate_at(env, SIDE_YES, margin, 20000, 0, 5000, PAYEE());
    // Push the price up so the take is met.
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, whale.public_key, 200 * ONE, 30000);
    let payee_before = env.token.balance_of(PAYEE());
    let keeper_before = env.token.balance_of(KEEPER());
    // The agent signs over the pinned PAYEE, because that is the only message that verifies.
    pool_agent_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE());
    assert(env.token.balance_of(PAYEE()) > payee_before, 'pinned target paid');
    // Nothing reached any other address, agent-chosen or otherwise.
    assert(env.token.balance_of(KEEPER()) == keeper_before, 'nobody else paid');
    assert_solvent(env);
}

/// Owner and agent signatures are never interchangeable, in either direction. An owner signature is
/// refused on the agent path (verified against the agent key) and an agent signature is refused on
/// the owner path (verified against the position key), so neither can be replayed as the other.
#[test]
#[fuzzer(runs: 24)]
#[feature("safe_dispatcher")]
fn fuzz_owner_and_agent_signatures_never_swap(seed: u128) {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let (owner, agent) = open_with_mandate(env, 0, 5000); // band already met
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    let target: felt252 = PAYEE().into();
    if seed % 2 == 0 {
        // Owner signature on the agent path.
        let (r, s) = sign_close(env, owner, 0, SIDE_YES, owner.public_key, target);
        start_cheat_caller_address(env.lev_addr, POOL());
        let result = safe
            .privacy_invoke(
                LeverageAction::AgentClose(
                    AgentCloseInput {
                        market_id: 0,
                        side: SIDE_YES,
                        position_key: owner.public_key,
                        signature_r: r,
                        signature_s: s,
                    },
                ),
            );
        stop_cheat_caller_address(env.lev_addr);
        match result {
            Result::Ok(_) => panic!("owner signature passed the agent path"),
            Result::Err(data) => assert(*data.at(0) == 'BAD_CLOSE_SIGNATURE', 'wrong err'),
        }
    } else {
        // Agent signature on the owner path.
        let (r, s) = sign_close(env, agent, 0, SIDE_YES, owner.public_key, target);
        start_cheat_caller_address(env.lev_addr, POOL());
        let result = safe
            .privacy_invoke(
                LeverageAction::Close(
                    CloseInput {
                        market_id: 0,
                        side: SIDE_YES,
                        position_key: owner.public_key,
                        signature_r: r,
                        signature_s: s,
                        target: PayoutTarget::Address(PAYEE()),
                    },
                ),
            );
        stop_cheat_caller_address(env.lev_addr);
        match result {
            Result::Ok(_) => panic!("agent signature passed the owner path"),
            Result::Err(data) => assert(*data.at(0) == 'BAD_CLOSE_SIGNATURE', 'wrong err'),
        }
    }
    assert(
        env.lev.get_position(0, SIDE_YES, owner.public_key).state == PositionState::Open, 'open',
    );
}

/// Solvency survives the agent path under random interleavings: a mandated position and a plain one
/// on random sides at random sizes, closed by an agent and by a keeper in either order.
#[test]
#[fuzzer(runs: 24)]
fn fuzz_agent_and_keeper_paths_stay_solvent(m1_raw: u128, m2_raw: u128, order_raw: u128) {
    let env = setup();
    add_lp(env, 20000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let m1 = bounded_u128(m1_raw, ONE, 40 * ONE);
    let m2 = bounded_u128(m2_raw, ONE, 40 * ONE);
    // A mandated 5x long YES with a stop, plus a plain 5x long YES beside it.
    let (owner, agent) = open_with_mandate_at(env, SIDE_YES, m1, 50000, 4900, 0, PAYEE());
    let plain = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_YES, plain.public_key, m2, 50000);
    assert_solvent(env);
    // Crash YES so the stop is met and the plain position is liquidatable.
    let whale = KeyPairTrait::<felt252, felt252>::generate();
    pool_open(env, 0, SIDE_NO, whale.public_key, 400 * ONE, 50000);
    assert_solvent(env);
    if order_raw % 2 == 0 {
        pool_agent_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE());
        assert_solvent(env);
        start_cheat_caller_address(env.lev_addr, KEEPER());
        env.lev.liquidate(0, SIDE_YES, plain.public_key);
        stop_cheat_caller_address(env.lev_addr);
    } else {
        start_cheat_caller_address(env.lev_addr, KEEPER());
        env.lev.liquidate(0, SIDE_YES, plain.public_key);
        stop_cheat_caller_address(env.lev_addr);
        assert_solvent(env);
        pool_agent_close(env, agent, 0, SIDE_YES, owner.public_key, PAYEE());
    }
    assert(env.lev.get_position(0, SIDE_YES, owner.public_key).state == PositionState::Closed, 'a');
    assert_solvent(env);
}

/// A mandate is write-once at open: there is no setter on the ABI and a second open on the same
/// key is refused, so the authority a position carries can never be widened after the fact. An
/// agent cannot grow its own powers. Neither can anyone else.
#[test]
#[feature("safe_dispatcher")]
fn a_mandate_cannot_be_changed_after_the_open() {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let (owner, agent) = open_with_mandate(env, 4000, 0);
    let attacker = KeyPairTrait::<felt252, felt252>::generate();
    // Re-opening the same (market, side, key) with a wider mandate must be refused outright.
    env.token.mint(env.lev_addr, (50 * ONE).into());
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    start_cheat_caller_address(env.lev_addr, POOL());
    let result = safe
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    margin: 50 * ONE,
                    leverage_bps: 20000,
                    max_price_bps: 10000,
                    mandate: Mandate {
                        agent_key: attacker.public_key,
                        stop_price_bps: 9999,
                        take_price_bps: 1,
                        payout_target: KEEPER(),
                    },
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match result {
        Result::Ok(_) => panic!("a mandate was overwritten"),
        Result::Err(data) => assert(*data.at(0) == 'POSITION_EXISTS', 'wrong err'),
    }
    // The original mandate is intact: same agent, same band, same pinned target.
    let m = env.lev.get_mandate(0, SIDE_YES, owner.public_key);
    assert(m.agent_key == agent.public_key, 'agent unchanged');
    assert(m.stop_price_bps == 4000, 'stop unchanged');
    assert(m.payout_target == PAYEE(), 'target unchanged');
}

/// A mandate naming an agent must name a payout address too and must grant at least one band.
/// An authority with nowhere to pay is rejected at the open, as is one with no condition, rather
/// than stored as a trap for later.
#[test]
#[feature("safe_dispatcher")]
fn a_mandate_must_be_well_formed() {
    let env = setup();
    add_lp(env, 5000 * ONE);
    create_market(env, 200 * ONE, 9999999999);
    let safe = ILeveragedMarketSafeDispatcher { contract_address: env.lev_addr };
    let agent = KeyPairTrait::<felt252, felt252>::generate();
    let owner = KeyPairTrait::<felt252, felt252>::generate();
    env.token.mint(env.lev_addr, (100 * ONE).into());

    // An agent with no payout address.
    start_cheat_caller_address(env.lev_addr, POOL());
    let no_target = safe
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    margin: 50 * ONE,
                    leverage_bps: 20000,
                    max_price_bps: 10000,
                    mandate: Mandate {
                        agent_key: agent.public_key,
                        stop_price_bps: 4000,
                        take_price_bps: 0,
                        payout_target: 0.try_into().unwrap(),
                    },
                },
            ),
        );
    match no_target {
        Result::Ok(_) => panic!("stored a mandate with no target"),
        Result::Err(data) => assert(*data.at(0) == 'ZERO_MANDATE_TARGET', 'wrong err'),
    }

    // An agent with a target but no band at all, which would be an unconditional authority.
    let no_band = safe
        .privacy_invoke(
            LeverageAction::Open(
                OpenInput {
                    market_id: 0,
                    side: SIDE_YES,
                    position_key: owner.public_key,
                    margin: 50 * ONE,
                    leverage_bps: 20000,
                    max_price_bps: 10000,
                    mandate: Mandate {
                        agent_key: agent.public_key,
                        stop_price_bps: 0,
                        take_price_bps: 0,
                        payout_target: PAYEE(),
                    },
                },
            ),
        );
    stop_cheat_caller_address(env.lev_addr);
    match no_band {
        Result::Ok(_) => panic!("stored an unconditional mandate"),
        Result::Err(data) => assert(*data.at(0) == 'BAD_MANDATE', 'wrong err'),
    }
}
