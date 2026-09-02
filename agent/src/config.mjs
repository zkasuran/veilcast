/// Every address, endpoint and tunable the agent runtime needs, resolved in one place.
///
/// Precedence is flag, then environment, then the verified mainnet default, so an agent can be
/// pointed anywhere without editing a file and a fresh clone still works with no configuration.
/// Every default here was read off mainnet, not copied from a doc.

/// Starknet mainnet, as Veilcast actually runs on it today.
export const MAINNET = {
    network: "mainnet",
    chainId: "SN_MAIN",
    /// Keyless public RPC. Swap it for your own endpoint under load.
    rpcUrl: "https://rpc.starknet.lava.build",
    /// The live STRK20 privacy pool.
    pool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    /// STRK. Every market is denominated in it. Same address on mainnet and Sepolia.
    token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    /// Veilcast's deployed contracts. "0x0" means not deployed on this network yet and every
    /// command that needs one says so rather than failing obscurely.
    market: "0x036be78d67d6e94b79d3a8a7891b67871d4f17342d4c323be8f6ed469c36c6b8",
    pragmaResolver: "0x0665a23caf88a7be47db35a7b6c4ecfae7de8d51405004d579f5553a680a259b",
    committeeResolver: "0x00b0dec2742d5f7f62bdc4a7b93c5caabe17b6b9d49200d9c1c0eae8e64e6cd7",
    leverage: "0x0",
    /// The STRK20 proving and discovery services, reachable over OHTTP. These are the same
    /// services a STRK20-enabled wallet uses to prove a pool action; they take no API key, which
    /// is what makes a headless agent possible at all. See docs/MAINNET-HEADLESS.md.
    provingUrl: "https://cloud.argent-api.com/v1/privacy/proving",
    discoveryUrl: "https://cloud.argent-api.com/v1/privacy/discovery",
    /// Prove against a block at least this many behind the head. The sequencer rejects a proof
    /// whose base block is newer than 10 blocks old and 15 leaves room for a reorg.
    proveLag: 15,
};

/// Risk parameters, mirroring the constants in cairo/src/leveraged_market.cairo. Duplicated here so
/// the agent can quote and plan without a chain read; the Cairo suite is the source of truth.
export const RISK = {
    leverageOne: 10_000,
    maxLeverage: 50_000,
    maintenanceMarginBps: 800,
    keeperRewardBps: 100,
    openFeeBps: 30,
    bps: 10_000,
};
/// Environment variable names, all optional. Listed here rather than scattered through the code so
/// `doctor` can report exactly which ones are set and INTEGRATION.md can be generated from one list.
export const ENV_KEYS = {
    rpcUrl: "VEILCAST_RPC_URL",
    pool: "VEILCAST_POOL",
    token: "VEILCAST_TOKEN",
    market: "VEILCAST_MARKET",
    leverage: "VEILCAST_LEVERAGE",
    provingUrl: "VEILCAST_PROVING_URL",
    discoveryUrl: "VEILCAST_DISCOVERY_URL",
    proveLag: "VEILCAST_PROVE_LAG",
    /// Where the agent's own keys and state live. Defaults to ./.veilcast in the working directory.
    home: "VEILCAST_HOME",
    /// The privacy SDK build the runtime imports. It is not on npm, so a path is required for any
    /// command that touches the pool. See `sdkStatus`.
    sdkPath: "VEILCAST_PRIVACY_SDK",
};

/// Resolve the effective config: defaults, overridden by environment, overridden by flags.
///
/// Nothing here reaches the network or the filesystem, so it is safe to call from anywhere and cheap
/// to call twice. `sdkPath` stays null when unset and the commands that need it say so plainly.
export function resolveConfig(overrides = {}, env = process.env) {
    const pick = (key, fallback) => {
        if (overrides[key] !== undefined && overrides[key] !== null) return overrides[key];
        const fromEnv = env[ENV_KEYS[key]];
        return fromEnv !== undefined && fromEnv !== "" ? fromEnv : fallback;
    };
    const proveLag = Number(pick("proveLag", MAINNET.proveLag));
    return {
        network: MAINNET.network,
        chainId: MAINNET.chainId,
        rpcUrl: pick("rpcUrl", MAINNET.rpcUrl),
        pool: pick("pool", MAINNET.pool),
        token: pick("token", MAINNET.token),
        market: pick("market", MAINNET.market),
        pragmaResolver: MAINNET.pragmaResolver,
        committeeResolver: MAINNET.committeeResolver,
        leverage: pick("leverage", MAINNET.leverage),
        provingUrl: pick("provingUrl", MAINNET.provingUrl),
        discoveryUrl: pick("discoveryUrl", MAINNET.discoveryUrl),
        proveLag: Number.isFinite(proveLag) && proveLag >= 10 ? proveLag : MAINNET.proveLag,
        home: pick("home", ".veilcast"),
        sdkPath: pick("sdkPath", null),
        risk: RISK,
    };
}

/// Whether an address names a real contract rather than the "0x0" placeholder. Callers use this to
/// refuse a command with a clear reason instead of sending a doomed transaction.
export function isDeployed(address) {
    try {
        return BigInt(address) !== 0n;
    } catch {
        return false;
    }
}


/// Build a config from already-parsed CLI or MCP arguments.
///
/// Lives here rather than in the CLI because the MCP transport needs the identical mapping: a browser
/// host passing `leverage: "3x"` must not be read as a contract address, which is why only a value
/// starting with 0x is treated as one.
export function configFrom(args = {}) {
    const asAddress = (value) => (typeof value === "string" && value.startsWith("0x") ? value : undefined);
    return resolveConfig({
        rpcUrl: args.rpc,
        market: asAddress(args.market),
        leverage: args["leverage-address"] ?? asAddress(args.leverage),
        sdkPath: args.sdk,
        home: args.home,
        proveLag: args["prove-lag"],
    });
}
