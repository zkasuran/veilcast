//! A stand-in for the STRK20 privacy pool, reduced to the phases the market depends on.
//!
//! The real pool applies an action list: a `withdraw` moves tokens to a public recipient, an
//! `invoke` calls `privacy_invoke` on a target and applies whatever open-note deposits it returns
//! by pulling them from the target. This mock keeps that order and that pull, so a market that
//! works here works against `_apply_invoke_and_deposits` upstream.

use starknet::ContractAddress;
use veilcast::interface::OpenNoteDeposit;

#[starknet::interface]
pub trait IMockPool<TState> {
    /// A `[withdraw, invoke]` action list: sends `amount` to `target`, then invokes it.
    fn withdraw_and_invoke(
        ref self: TState, target: ContractAddress, amount: u256, calldata: Span<felt252>,
    ) -> Span<OpenNoteDeposit>;
    /// An `[invoke]` action list with no withdrawal, which is what a claim looks like.
    fn invoke(
        ref self: TState, target: ContractAddress, calldata: Span<felt252>,
    ) -> Span<OpenNoteDeposit>;
    /// Amount deposited into `note_id` by the invokes applied so far.
    fn get_note_amount(self: @TState, note_id: felt252) -> u128;
}

#[starknet::contract]
pub mod MockPool {
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
    use veilcast::interface::{IErc20Dispatcher, IErc20DispatcherTrait, OpenNoteDeposit};
    use veilcast::test_utils_contracts::mock_erc20::{
        IMockErc20Dispatcher, IMockErc20DispatcherTrait,
    };
    use super::IMockPool;

    mod errors {
        pub const INVALID_INVOKE_RETURN_DATA: felt252 = 'INVALID_INVOKE_RETURN_DATA';
    }

    #[storage]
    struct Storage {
        token: ContractAddress,
        notes: Map<felt252, u128>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, token: ContractAddress) {
        self.token.write(token);
    }

    #[abi(embed_v0)]
    impl MockPoolImpl of IMockPool<ContractState> {
        fn withdraw_and_invoke(
            ref self: ContractState, target: ContractAddress, amount: u256, calldata: Span<felt252>,
        ) -> Span<OpenNoteDeposit> {
            IErc20Dispatcher { contract_address: self.token.read() }
                .transfer(recipient: target, :amount);
            self.invoke(:target, :calldata)
        }

        fn invoke(
            ref self: ContractState, target: ContractAddress, calldata: Span<felt252>,
        ) -> Span<OpenNoteDeposit> {
            let mut return_data = call_contract_syscall(
                address: target, entry_point_selector: selector!("privacy_invoke"), :calldata,
            )
                .unwrap_syscall();
            let deposits: Span<OpenNoteDeposit> = Serde::deserialize(ref return_data)
                .expect(errors::INVALID_INVOKE_RETURN_DATA);
            assert(return_data.is_empty(), errors::INVALID_INVOKE_RETURN_DATA);

            let token = IMockErc20Dispatcher { contract_address: self.token.read() };
            for deposit in deposits {
                let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposit;
                // The pool pulls the payout out of the target, exactly as the real one does.
                token
                    .transfer_from(
                        sender: target, recipient: get_contract_address(), amount: amount.into(),
                    );
                assert(deposit_token == self.token.read(), errors::INVALID_INVOKE_RETURN_DATA);
                let note_entry = self.notes.entry(note_id);
                note_entry.write(note_entry.read() + amount);
            }
            deposits
        }

        fn get_note_amount(self: @ContractState, note_id: felt252) -> u128 {
            self.notes.entry(note_id).read()
        }
    }
}
