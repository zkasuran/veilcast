//! The slice of the Pragma oracle this repo needs, declared here rather than pulled in.
//!
//! `pragma_lib` is a git dependency that would drag a whole SDK in for one entry point, so the
//! three shapes `get_data_median` needs are declared locally, field for field with
//! [pragma-lib](https://github.com/astraly-labs/pragma-lib) (`src/types.cairo`, `src/abi.cairo`).
//! Serde is positional, so the field order below is the wire format. Getting it wrong is a
//! deserialization failure at call time, which is why the mock oracle in the tests speaks this
//! exact interface: if this drifts from Pragma, the mock drifts with it and the tests still pass,
//! so the layout was also checked against the live feeds.
//!
//! Verified on 2026-08-16, `get_data_median(SpotEntry('STRK/USD'))`:
//! - mainnet `0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b`, 12 sources,
//!   8 decimals, nine minutes old
//! - sepolia `0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a`, 1 source,
//!   8 decimals, months old, which is why the staleness window is a constructor argument

/// What a feed is being asked about. Only `SpotEntry` is used here. The other variants stay so the
/// variant indices, which is what Serde actually sends, match the oracle's.
#[derive(Copy, Drop, Serde)]
pub enum DataType {
    /// A spot pair id: the ticker as a short string, `'STRK/USD'`.
    SpotEntry: felt252,
    FutureEntry: (felt252, u64),
    GenericEntry: felt252,
}

/// The aggregate a feed answers with.
#[derive(Copy, Drop, Serde)]
pub struct PragmaPricesResponse {
    /// The median, scaled by `decimals`: STRK/USD at 8 decimals reports 2290000 for $0.0229.
    pub price: u128,
    pub decimals: u32,
    /// When the aggregate last moved, in unix seconds.
    pub last_updated_timestamp: u64,
    /// How many publishers went into the median. Zero means the feed has nothing to say, which is
    /// not the same as a price of zero.
    pub num_sources_aggregated: u32,
    pub expiration_timestamp: Option<u64>,
}

#[starknet::interface]
pub trait IPragmaOracle<TState> {
    fn get_data_median(self: @TState, data_type: DataType) -> PragmaPricesResponse;
}
