import { ProviderInterface, RpcProvider, num } from "starknet";

// ─── Token ──────────────────────────────────────────────────────────────────

// Every market is denominated in one ERC20: STRK. Stakes are shielded STRK notes,
// so this is also the token the pool withdraws into the market contract.
export const addrSTRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// ─── Networks ───────────────────────────────────────────────────────────────

// An Alchemy key is optional. Given one the app uses it, and without one it falls back to a keyless
// public endpoint, so a fresh clone and the hosted demo both work with no configuration. Every URL
// here was checked against the live network: Alchemy serves RPC spec 0.10, Cartridge serves 0.10.2
// on Mainnet and 0.9.0 on Sepolia. The starter kit's blastapi endpoints are gone, Blast shut its
// public API down and now answers every call with an error.
const alchemyKey = process.env.NEXT_PUBLIC_PROVIDER_URL;

function nodeUrl(network: "mainnet" | "sepolia"): string {
    return alchemyKey
        ? `https://starknet-${network}.g.alchemy.com/starknet/version/rpc/v0_10/${alchemyKey}`
        : `https://api.cartridge.gg/x/starknet/${network}`;
}

// Frontend RPC providers, indexed. The index is wiring, not a list: 0 is Mainnet, 2 is Sepolia, and
// the wallet flow maps a chain id onto one of those two. Index 1 is a spare Sepolia endpoint that
// never depends on the key, which is what to switch to when a key is rate-limited or wrong.
export const myFrontendProviders: ProviderInterface[] = [
    new RpcProvider({ nodeUrl: nodeUrl("mainnet") }),
    new RpcProvider({ nodeUrl: "https://api.cartridge.gg/x/starknet/sepolia" }),
    new RpcProvider({ nodeUrl: nodeUrl("sepolia") }),
];

// Frontend provider indices where the STRK20 privacy pool is available, mapped to a
// display name. Used to gate every pool action.
export const Strk20Networks: Record<number, string> = { 0: "MAINNET", 2: "SEPOLIA" };

// ─── Veilcast market contract ───────────────────────────────────────────────
// One deployment per network, set in .env.local. "0x0" means not deployed there
// yet, and the app says so rather than pretending to have a board.

export const veilcastMarketMainnet = process.env.NEXT_PUBLIC_VEILCAST_MARKET_MAINNET ?? "0x0";
export const veilcastMarketSepolia = process.env.NEXT_PUBLIC_VEILCAST_MARKET_SEPOLIA ?? "0x0";

// ─── Pragma resolver ────────────────────────────────────────────────────────
// Optional companion contract (cairo/src/pragma_resolver.cairo). Deployed, it lets a market be
// bound to a price feed and settled by anyone from that feed. Absent, the app still works: every
// market is then settled by whoever opened it.

export const veilcastResolverMainnet = process.env.NEXT_PUBLIC_VEILCAST_RESOLVER_MAINNET ?? "0x0";
export const veilcastResolverSepolia = process.env.NEXT_PUBLIC_VEILCAST_RESOLVER_SEPOLIA ?? "0x0";

/// The Pragma resolver for a frontend provider index, or "0x0" where it is not deployed.
export function resolverForIndex(index: number): string {
    if (index === 0) return veilcastResolverMainnet;
    if (index === 2) return veilcastResolverSepolia;
    return "0x0";
}

// ─── Committee resolver ─────────────────────────────────────────────────────
// Optional companion (cairo/src/committee_resolver.cairo). Deployed, it lets a market be settled by
// a vote of named jurors, for questions no feed can answer. Absent, the app still works: markets are
// then settled by a single named resolver or a price feed.

export const veilcastCommitteeMainnet = process.env.NEXT_PUBLIC_VEILCAST_COMMITTEE_MAINNET ?? "0x0";
export const veilcastCommitteeSepolia = process.env.NEXT_PUBLIC_VEILCAST_COMMITTEE_SEPOLIA ?? "0x0";

/// The committee resolver for a frontend provider index, or "0x0" where it is not deployed.
export function committeeForIndex(index: number): string {
    if (index === 0) return veilcastCommitteeMainnet;
    if (index === 2) return veilcastCommitteeSepolia;
    return "0x0";
}

// ─── Leveraged market ───────────────────────────────────────────────────────
// Optional companion (cairo/src/leveraged_market.cairo): leveraged, isolated-margin positions on
// an FPMM book, opened and closed privately through the pool. "0x0" means it is not deployed on
// that network yet, and the Leverage tab says so rather than pretending to have a book.

export const veilcastLeverageMainnet = process.env.NEXT_PUBLIC_VEILCAST_LEVERAGE_MAINNET ?? "0x0";
export const veilcastLeverageSepolia = process.env.NEXT_PUBLIC_VEILCAST_LEVERAGE_SEPOLIA ?? "0x0";

/// The leveraged market for a frontend provider index, or "0x0" where it is not deployed.
export function leverageForIndex(index: number): string {
    if (index === 0) return veilcastLeverageMainnet;
    if (index === 2) return veilcastLeverageSepolia;
    return "0x0";
}

/// The market contract for a frontend provider index (0 = Mainnet, 2 = Sepolia),
/// or "0x0" where it is not deployed.
export function marketForIndex(index: number): string {
    if (index === 0) return veilcastMarketMainnet;
    if (index === 2) return veilcastMarketSepolia;
    return "0x0";
}

/// Whether an address string names a real contract rather than the "0x0" placeholder.
export function isDeployedAt(address: string): boolean {
    try {
        return num.toBigInt(address) !== 0n;
    } catch {
        return false;
    }
}

// ─── Explorer links ─────────────────────────────────────────────────────────

/// Voyager transaction link for the network behind a frontend provider index.
export function voyagerTxUrl(index: number, txHash: string): string {
    return `${voyagerBase(index)}/tx/${txHash}`;
}

/// Voyager contract link for the network behind a frontend provider index.
export function voyagerContractUrl(index: number, address: string): string {
    return `${voyagerBase(index)}/contract/${address}`;
}

function voyagerBase(index: number): string {
    return index === 0 ? "https://voyager.online" : "https://sepolia.voyager.online";
}
