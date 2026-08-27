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
    CLOSE_MESSAGE_TAG, CloseInput, ILeveragedMarketDispatcher, ILeveragedMarketDispatcherTrait,
    ILeveragedMarketSafeDispatcher, ILeveragedMarketSafeDispatcherTrait, LeverageAction, OpenInput,
    PositionState, SIDE_NO, SIDE_YES,
};
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
                    market_id, side, position_key: key, margin, leverage_bps, max_price_bps: 10000,
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
