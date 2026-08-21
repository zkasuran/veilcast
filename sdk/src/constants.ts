import { num, shortString } from "starknet";

/// Reference addresses on Starknet, for a caller that would rather not hardcode them. Everything
/// here is public on-chain data. The Veilcast market and resolvers are per-deployment, so this SDK
/// does not ship their addresses; you pass them to the read and call helpers.

/// STRK, the token every Veilcast market is denominated in. Same address on Mainnet and Sepolia.
export const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/// The live STRK20 privacy pool on Starknet mainnet, from the sprint's day-0 doc.
export const STRK20_POOL_MAINNET =
    "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

/// Pragma's oracle, the feed a price market settles from. Verified live on 2026-08-16.
export const PRAGMA_ORACLE_MAINNET =
    "0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b";
export const PRAGMA_ORACLE_SEPOLIA =
    "0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a";

/// STRK in the token's smallest unit.
export const STRK_UNIT = 10n ** 18n;

/// Formats an amount in the token's smallest unit as a STRK string, trimmed to `maxFractionDigits`
/// with trailing zeros dropped ("4.5", "0.0001", "12").
export function formatStrk(amount: bigint, maxFractionDigits = 4): string {
    const whole = amount / STRK_UNIT;
    const fraction = (amount % STRK_UNIT)
        .toString()
        .padStart(18, "0")
        .slice(0, maxFractionDigits)
        .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/// Parses a STRK amount into the token's smallest unit, or null for anything that is not a positive
/// number, so a caller never has to trust the input.
export function parseStrk(input: string): bigint | null {
    const trimmed = input.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
    const [whole, fraction = ""] = trimmed.split(".");
    if (fraction.length > 18) return null;
    const amount =
        BigInt(whole === "" ? "0" : whole) * STRK_UNIT +
        BigInt(fraction.padEnd(18, "0") === "" ? "0" : fraction.padEnd(18, "0"));
    return amount > 0n ? amount : null;
}

/// A category as a felt, for calldata. Empty means uncategorised, which the contract accepts as zero.
export function encodeCategory(category: string): string {
    const trimmed = category.trim();
    return trimmed === "" ? "0x0" : shortString.encodeShortString(trimmed);
}

/// Reads a category felt back to text. Anything that is not a short string reads as uncategorised.
export function decodeCategory(raw: bigint | string | number): string {
    try {
        const value = BigInt(raw as bigint);
        return value === 0n ? "" : shortString.decodeShortString(num.toHex(value));
    } catch {
        return "";
    }
}
