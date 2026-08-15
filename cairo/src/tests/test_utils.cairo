use core::panic_with_felt252;
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;
use veilcast::interface::{
    BetInput, ClaimInput, IVeilcastMarketDispatcher, IVeilcastMarketDispatcherTrait, MarketAction,
    OpenNoteDeposit, PayoutTarget,
};
use veilcast::market::claim_message_hash;
use veilcast::test_utils_contracts::mock_erc20::{IMockErc20Dispatcher, IMockErc20DispatcherTrait};
use veilcast::test_utils_contracts::mock_pool::{IMockPoolDispatcher, IMockPoolDispatcherTrait};

/// One STRK in the token's smallest unit.
pub const ONE_STRK: u128 = 1_000_000_000_000_000_000;

/// A coupon keypair: the public key owns the position, the private key releases the payout.
pub type CouponKeyPair = KeyPair<felt252, felt252>;

#[derive(Drop, Copy)]
pub struct Veilcast {
    pub token: IMockErc20Dispatcher,
    pub pool: IMockPoolDispatcher,
    pub market: IVeilcastMarketDispatcher,
}

pub fn deploy_veilcast() -> Veilcast {
    let (token_address, _) = declare("MockErc20")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();
    let (pool_address, _) = declare("MockPool")
        .unwrap()
        .contract_class()
        .deploy(@array![token_address.into()])
        .unwrap();
    let (market_address, _) = declare("VeilcastMarket")
        .unwrap()
        .contract_class()
        .deploy(@array![pool_address.into(), token_address.into()])
        .unwrap();
    let token = IMockErc20Dispatcher { contract_address: token_address };
    // The pool pays every withdrawal out of its own reserves, so give it some.
    token.mint(recipient: pool_address, amount: 1_000_000_u256 * ONE_STRK.into());
    Veilcast {
        token,
        pool: IMockPoolDispatcher { contract_address: pool_address },
        market: IVeilcastMarketDispatcher { contract_address: market_address },
    }
}

pub fn new_coupon() -> CouponKeyPair {
    KeyPairTrait::<felt252, felt252>::generate()
}

pub fn serialize_action(action: MarketAction) -> Span<felt252> {
    let mut calldata: Array<felt252> = array![];
    action.serialize(ref calldata);
    calldata.span()
}

/// Asserts a safe-dispatcher call reverted with `expected`. A safe dispatcher appends
/// `ENTRYPOINT_FAILED` to the callee's panic data, so only the first felt is the error itself.
pub fn assert_panic<T, +Drop<T>>(result: Result<T, Array<felt252>>, expected: felt252) {
    match result {
        Result::Ok(_) => panic_with_felt252('EXPECTED_A_PANIC'),
        Result::Err(panic_data) => {
            assert!(panic_data.len() >= 1);
            assert_eq!(*panic_data.at(0), expected);
        },
    }
}

#[generate_trait]
pub impl VeilcastImpl of VeilcastTrait {
    /// Opens a two-outcome market closing at `close_at`, resolved by `resolver`.
    fn create_binary_market(self: @Veilcast, resolver: ContractAddress, close_at: u64) -> u64 {
        (*self.market)
            .create_market(
                question: "Will STRK close above 1 USD?",
                outcome_labels: array!["Yes", "No"],
                :resolver,
                :close_at,
            )
    }

    /// A `[withdraw, invoke]` action list: the pool moves the stake in, then the market books it.
    fn bet(self: @Veilcast, market_id: u64, outcome: u8, amount: u128, position_key: felt252) {
        (*self.pool)
            .withdraw_and_invoke(
                target: *self.market.contract_address,
                amount: amount.into(),
                calldata: serialize_action(
                    MarketAction::Bet(BetInput { market_id, outcome, amount, position_key }),
                ),
            );
    }

    /// An `[invoke]` action list that pays into the open note `note_id`.
    fn claim_to_note(
        self: @Veilcast, market_id: u64, outcome: u8, coupon: CouponKeyPair, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        self.claim(:market_id, :outcome, :coupon, target: PayoutTarget::OpenNote(note_id))
    }

    /// An `[invoke]` action list that pays `recipient` directly.
    fn claim_to_address(
        self: @Veilcast,
        market_id: u64,
        outcome: u8,
        coupon: CouponKeyPair,
        recipient: ContractAddress,
    ) -> Span<OpenNoteDeposit> {
        self.claim(:market_id, :outcome, :coupon, target: PayoutTarget::Address(recipient))
    }

    /// Signs the coupon for the target it actually claims to.
    fn claim(
        self: @Veilcast, market_id: u64, outcome: u8, coupon: CouponKeyPair, target: PayoutTarget,
    ) -> Span<OpenNoteDeposit> {
        let signed_target = match target {
            PayoutTarget::OpenNote(_) => 0,
            PayoutTarget::Address(recipient) => recipient.into(),
        };
        self.claim_signed_for(:market_id, :outcome, :coupon, :target, :signed_target)
    }

    /// Signs for `signed_target` but claims to `target`, so a test can break the binding.
    fn claim_signed_for(
        self: @Veilcast,
        market_id: u64,
        outcome: u8,
        coupon: CouponKeyPair,
        target: PayoutTarget,
        signed_target: felt252,
    ) -> Span<OpenNoteDeposit> {
        let (signature_r, signature_s) = coupon
            .sign(
                claim_message_hash(
                    market_address: *self.market.contract_address,
                    :market_id,
                    :outcome,
                    position_key: coupon.public_key,
                    target: signed_target,
                ),
            )
            .unwrap();
        (*self.pool)
            .invoke(
                target: *self.market.contract_address,
                calldata: serialize_action(
                    MarketAction::Claim(
                        ClaimInput {
                            market_id,
                            outcome,
                            position_key: coupon.public_key,
                            signature_r,
                            signature_s,
                            target,
                        },
                    ),
                ),
            )
    }
}
