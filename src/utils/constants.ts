import { ProviderInterface, RpcProvider, num } from "starknet";

// ─── Token ──────────────────────────────────────────────────────────────────

// Every market is denominated in one ERC20: STRK. Stakes are shielded STRK notes,
// so this is also the token the pool withdraws into the market contract.
export const addrSTRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// ─── Networks ───────────────────────────────────────────────────────────────

// Frontend RPC providers, indexed. The STRK20 privacy pool lives on Mainnet (0)
// and Sepolia (2); index 1 is a spare public testnet endpoint. NEXT_PUBLIC_PROVIDER_URL
// is your Alchemy key (see .env.example).
export const myFrontendProviders: ProviderInterface[] = [
    new RpcProvider({ nodeUrl: "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/" + process.env.NEXT_PUBLIC_PROVIDER_URL }),
    new RpcProvider({ nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_7" }),
    new RpcProvider({ nodeUrl: "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/" + process.env.NEXT_PUBLIC_PROVIDER_URL })];

// Frontend provider indices where the STRK20 privacy pool is available, mapped to a
// display name. Used to gate every pool action.
export const Strk20Networks: Record<number, string> = { 0: "MAINNET", 2: "SEPOLIA" };

// ─── Veilcast market contract ───────────────────────────────────────────────
// One deployment per network, set in .env.local. "0x0" means not deployed there
// yet, and the app says so rather than pretending to have a board.

export const veilcastMarketMainnet = process.env.NEXT_PUBLIC_VEILCAST_MARKET_MAINNET ?? "0x0";
export const veilcastMarketSepolia = process.env.NEXT_PUBLIC_VEILCAST_MARKET_SEPOLIA ?? "0x0";

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
