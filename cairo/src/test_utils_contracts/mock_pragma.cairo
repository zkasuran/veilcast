//! A stand-in for the Pragma oracle, holding whatever median a test wants it to report.
//!
//! It implements the same `IPragmaOracle` the resolver calls in production, so the resolver cannot
//! tell the difference. What that does not prove is that the interface matches Pragma's own; the
//! notes in `pragma.cairo` record how that was checked against the live feeds.

#[starknet::interface]
pub trait IMockPragmaOracle<TState> {
    /// Sets what the feed reports for `pair_id`. A pair nobody has set reads back with zero
    /// sources, which is how the real oracle says it has nothing.
    fn set_median(
        ref self: TState,
        pair_id: felt252,
        price: u128,
        decimals: u32,
        last_updated_timestamp: u64,
        num_sources_aggregated: u32,
    );
}

#[starknet::contract]
pub mod MockPragmaOracle {
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use veilcast::pragma::{DataType, IPragmaOracle, PragmaPricesResponse};
    use super::IMockPragmaOracle;

    #[storage]
    struct Storage {
        /// (price, decimals, last_updated_timestamp, num_sources_aggregated) per pair.
        medians: Map<felt252, (u128, u32, u64, u32)>,
    }

    #[abi(embed_v0)]
    impl MockPragmaOracleImpl of IMockPragmaOracle<ContractState> {
        fn set_median(
            ref self: ContractState,
            pair_id: felt252,
            price: u128,
            decimals: u32,
            last_updated_timestamp: u64,
            num_sources_aggregated: u32,
        ) {
            self
                .medians
                .entry(pair_id)
                .write((price, decimals, last_updated_timestamp, num_sources_aggregated));
        }
    }

    #[abi(embed_v0)]
    impl PragmaOracleImpl of IPragmaOracle<ContractState> {
        fn get_data_median(self: @ContractState, data_type: DataType) -> PragmaPricesResponse {
            let pair_id = match data_type {
                DataType::SpotEntry(pair_id) => pair_id,
                _ => 0,
            };
            let (price, decimals, last_updated_timestamp, num_sources_aggregated) = self
                .medians
                .entry(pair_id)
                .read();
            PragmaPricesResponse {
                price,
                decimals,
                last_updated_timestamp,
                num_sources_aggregated,
                expiration_timestamp: Option::None,
            }
        }
    }
}
