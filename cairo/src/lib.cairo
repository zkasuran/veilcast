//! Veilcast: private prediction markets on the STRK20 privacy pool.
//!
//! `interface` declares the market ABI and its calldata layout, `market` implements it.
//! The pool drives the contract through `privacy_invoke`, so a bet or a claim carries no
//! bettor address: the on-chain sender is the pool.

pub mod interface;
pub mod market;

#[cfg(test)]
mod test_utils_contracts;
#[cfg(test)]
mod tests;
