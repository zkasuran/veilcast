//! Veilcast: private prediction markets on the STRK20 privacy pool.
//!
//! `interface` declares the market ABI and its calldata layout, `market` implements it.
//! The pool drives the contract through `privacy_invoke`, so a bet or a claim carries no
//! bettor address: the on-chain sender is the pool.
//!
//! `pragma_resolver` is an optional companion: a market names one resolver address, and pointing it
//! at that contract settles a price question from a Pragma feed instead of from someone's judgment.
//! `committee_resolver` is the other companion: for a question no feed can answer, it settles a
//! market by a vote of named jurors rather than by one trusted address.

pub mod committee_resolver;
pub mod interface;
pub mod market;
pub mod pragma;
pub mod pragma_resolver;

#[cfg(test)]
mod test_utils_contracts;
#[cfg(test)]
mod tests;
