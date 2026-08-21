/// veilcast-sdk: read and drive Veilcast, the private prediction market on Starknet's STRK20 pool,
/// from any TypeScript app or bot.
///
/// The design in one line: amounts and odds are public so the price signal is honest, and who bet is
/// not. This SDK never asks for or handles a wallet address for a bet; it builds the STRK20 action
/// lists the privacy pool runs on your behalf, and the pool's relayer is the on-chain sender.
///
/// Three groups of exports:
/// - **reads** (`loadBoard`, `loadMarket`, `loadStake`, `loadMarketEvents`, `oddsSeries`,
///   `loadPriceQuestion`, `loadMedian`, `loadCommittee`, ...): take a starknet.js provider.
/// - **calls** (`createMarketCall`, `resolveCall`, `openPriceMarketCall`, `voteCall`, ...): return a
///   `Call` for `account.execute`, for the public admin a market allows.
/// - **actions** (`betActions`, `claimIntoNoteActions`, `batchClaimIntoNotesActions`, ...): return an
///   STRK20 action list for `walletAccount.strk20InvokeTransaction`, which is how a bet or a claim
///   stays private.

export * from "./abi.js";
export * from "./constants.js";
export * from "./coupon.js";
export * from "./actions.js";
export * from "./market.js";
export * from "./resolver.js";
export * from "./committee.js";
export * from "./events.js";
