//! Minimal ERC20 for tests: just the surface the market and the mock pool move tokens over.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn allowance(self: @TState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn mint(ref self: TState, recipient: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockErc20 {
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::IMockErc20;

    mod errors {
        pub const INSUFFICIENT_BALANCE: felt252 = 'ERC20: insufficient balance';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'ERC20: insufficient allowance';
    }

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[abi(embed_v0)]
    impl MockErc20Impl of IMockErc20<ContractState> {
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.entry(account).read()
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.entry((owner, spender)).read()
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            self.move_tokens(sender: get_caller_address(), :recipient, :amount);
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let spender = get_caller_address();
            let allowance_entry = self.allowances.entry((sender, spender));
            let allowance = allowance_entry.read();
            assert(allowance >= amount, errors::INSUFFICIENT_ALLOWANCE);
            allowance_entry.write(allowance - amount);
            self.move_tokens(:sender, :recipient, :amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.allowances.entry((get_caller_address(), spender)).write(amount);
            true
        }

        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            let balance_entry = self.balances.entry(recipient);
            balance_entry.write(balance_entry.read() + amount);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn move_tokens(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) {
            let sender_entry = self.balances.entry(sender);
            let sender_balance = sender_entry.read();
            assert(sender_balance >= amount, errors::INSUFFICIENT_BALANCE);
            sender_entry.write(sender_balance - amount);
            let recipient_entry = self.balances.entry(recipient);
            recipient_entry.write(recipient_entry.read() + amount);
        }
    }
}
