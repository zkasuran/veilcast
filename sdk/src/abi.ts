import marketAbi from "./abi/veilcastMarket.json" with { type: "json" };
import pragmaResolverAbi from "./abi/pragmaResolver.json" with { type: "json" };
import committeeResolverAbi from "./abi/committeeResolver.json" with { type: "json" };
import type { Abi } from "starknet";

/// The contract ABIs, generated from the Cairo build, ready to hand to a starknet.js `Contract`.
/// These are the interface Veilcast actually exposes; the calldata builders in this SDK are written
/// against the same shapes, so a call this SDK produces is one the contract accepts.
export const VEILCAST_MARKET_ABI = marketAbi as Abi;
export const PRAGMA_RESOLVER_ABI = pragmaResolverAbi as Abi;
export const COMMITTEE_RESOLVER_ABI = committeeResolverAbi as Abi;
