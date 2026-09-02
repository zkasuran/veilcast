/// The write path: pool actions submitted headlessly on mainnet.
///
/// This is the part the rest of the field cannot do. The mainnet proving service URL was never
/// published, so every other STRK20 dapp needs a human driving a browser wallet that has the prover
/// baked in. The proving and discovery services are reachable over OHTTP without an API key, so a
/// process can prove and submit a pool action on its own. That is what makes an autonomous agent
/// possible here at all.
///
/// Every hard-won rule of that flow is encoded once, in this file:
///
/// 1. The viewing key must be canonical: `poseidon([pk]) mod (n/2)`, never zero or the prover
///    refuses with PRIVATE_KEY_NOT_CANONICAL. See `viewingKey` in keys.mjs.
/// 2. Prove against `head - proveLag` (15). A base block newer than ~10 blocks is rejected.
/// 3. Submit is proof-carrying and single-call: `account.execute([call], { proofFacts, proof })`.
///    Wrapping it in a multicall breaks ProofFacts parsing and the pool rejects it.
/// 4. The pool's STRK allowance is a separate, ordinary transaction, sent first. The pool
///    `transferFrom`s both the deposit and its fee, so a missing allowance fails the whole action.
/// 5. A fresh account's first deposit must be the atomic register plus setup plus deposit. Running
///    setup alone gives NO_REPLAY_PROTECTION; registering then auto-setting-up a dirty account gives
///    SUBCHANNEL_NOT_FOUND.
/// 6. Later deposits must wait for the previous note to be indexed or the prover returns
///    INDEX_NOT_SEQUENTIAL. `waitForNote` polls discovery instead of sleeping blindly.
/// 7. Debugging is free. The prover simulates server-side and rejects a bad invocation at prove()
///    time with the real Cairo felt, before any gas is spent, so a dry run is genuinely informative.

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Account, RpcProvider, constants } from "starknet";
import { viewingKey } from "./keys.mjs";

/// Load the STRK20 privacy SDK from a local build.
///
/// It is not published to npm, so there is nothing to install: the operator points at a built copy
/// with VEILCAST_PRIVACY_SDK. Failing here with an actionable message matters more than most errors,
/// because it is the one setup step that cannot be automated away.
export async function loadPrivacySdk(config) {
    if (!config.sdkPath) {
        const error = new Error(
            "No STRK20 privacy SDK path. Set VEILCAST_PRIVACY_SDK to a built copy of @starkware-libs/starknet-privacy-sdk (npm i && npm run build in its sdk directory). It is not published to npm, so it cannot be installed automatically. Read-only commands work without it."
        );
        error.code = "NO_PRIVACY_SDK";
        throw error;
    }
    const base = resolve(config.sdkPath);
    const candidates = [base, `${base}/dist/index.js`, `${base}/index.js`];
    let lastError;
    for (const candidate of candidates) {
        try {
            const module = await import(candidate.startsWith("/") ? `file://${candidate}` : candidate);
            if (module.createPrivateTransfers) {
                const interfaces = await loadInterfaces(candidate);
                return { ...module, Open: interfaces?.Open };
            }
        } catch (cause) {
            lastError = cause;
        }
    }
    const error = new Error(
        `Could not load the privacy SDK from ${base}. Tried ${candidates.join(", ")}. Build it first, then point VEILCAST_PRIVACY_SDK at the package root or its dist/index.js.`
    );
    error.code = "PRIVACY_SDK_UNLOADABLE";
    error.cause = lastError;
    throw error;
}

/// The `Open` sentinel lives in the SDK's interfaces module rather than its index in some builds. It
/// marks a transfer whose amount is decided by the contract, which is how a payout lands in a note.
async function loadInterfaces(indexPath) {
    try {
        const require = createRequire(import.meta.url);
        void require;
        const interfacesPath = indexPath.replace(/index\.js$/, "interfaces.js");
        return await import(interfacesPath.startsWith("/") ? `file://${interfacesPath}` : interfacesPath);
    } catch {
        return undefined;
    }
}

/// Everything a write needs: a funded starknet.js account, the private-transfers builder wired to the
/// OHTTP services and the block it will prove against.
export async function openSession(config, funding) {
    const sdk = await loadPrivacySdk(config);
    const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    const account = new Account({
        provider,
        address: funding.address,
        signer: funding.privateKey,
        cairoVersion: "1",
    });
    const head = await provider.getBlockLatestAccepted();
    const proveAt = head.block_number - config.proveLag;
    const discovery = new sdk.IndexerDiscoveryProvider(config.discoveryUrl, config.pool, { ohttp: true });
    const transfers = sdk.createPrivateTransfers({
        account,
        viewingKeyProvider: { getViewingKey: async () => viewingKey(funding.privateKey) },
        provingProvider: {
            url: config.provingUrl,
            chainId: constants.StarknetChainId.SN_MAIN,
            ohttp: true,
            nodeUrl: config.rpcUrl,
            blockIdentifier: proveAt,
        },
        discoveryProvider: discovery,
        poolContractAddress: config.pool,
    });
    return { sdk, provider, account, transfers, discovery, head: head.block_number, proveAt, Open: sdk.Open };
}

/// Submit a proved pool action.
///
/// Single call, proof carried alongside. `dryRun` stops after proving, which still validates the whole
/// action server-side and costs nothing, so an agent can check its work before committing.
export async function submitProved(session, callAndProof, { dryRun = true, waitFor = true } = {}) {
    if (dryRun) {
        return {
            submitted: false,
            dryRun: true,
            provedCalldataFelts: callAndProof.call.calldata.length,
            note: "Proved and validated server-side. Nothing was sent and no gas was spent. Re-run with confirm to submit.",
        };
    }
    const sent = await session.account.execute([callAndProof.call], {
        proofFacts: callAndProof.proof.proofFacts,
        proof: callAndProof.proof.data,
    });
    if (!waitFor) return { submitted: true, dryRun: false, txHash: sent.transaction_hash, awaited: false };
    await session.provider.waitForTransaction(sent.transaction_hash, { retryInterval: 3000, retries: 400 });
    return { submitted: true, dryRun: false, txHash: sent.transaction_hash, awaited: true };
}

/// Approve the pool to pull STRK. An ordinary transaction and it has to land before any deposit.
export async function approvePool(session, config, amount, { dryRun = true } = {}) {
    const call = {
        contractAddress: config.token,
        entrypoint: "approve",
        calldata: [config.pool, amount.toString(), "0"],
    };
    if (dryRun) return { submitted: false, dryRun: true, call, note: "Allowance not sent." };
    const sent = await session.account.execute([call]);
    await session.provider.waitForTransaction(sent.transaction_hash, { retryInterval: 3000 });
    return { submitted: true, dryRun: false, txHash: sent.transaction_hash };
}

/// Shield STRK into the pool.
///
/// A fresh account needs the atomic register plus setup plus deposit, which is why `first` exists;
/// running the steps separately fails. A later deposit only needs discovery refreshed, but the prior
/// note has to be indexed first, so callers should `waitForNote` between deposits.
export async function shield(session, config, amount, { first = false, dryRun = true } = {}) {
    const build = first
        ? session.transfers.build({
              autoRegister: true,
              autoSetup: true,
              autoDiscover: { notes: "refresh", channels: "refresh" },
          })
        : session.transfers.build({ autoDiscover: { notes: "refresh", channels: "refresh" } });
    const proved = await build.with(config.token).deposit({ amount }).execute();
    return submitProved(session, proved.callAndProof, { dryRun });
}

/// Place a private bet: withdraw the stake into the market, then invoke the market to book it, in one
/// atomic pool transaction. The chain records the pool as the sender, never the bettor.
export async function poolBet(session, config, { calldata, amount, surplusTo }, { dryRun = true } = {}) {
    const proved = await session.transfers
        .build({ autoDiscover: { notes: "refresh", channels: "refresh" }, autoSelectNotes: "all" })
        .with(config.token)
        .withdraw({ recipient: config.market, amount })
        .surplusTo(surplusTo)
        .done()
        .invoke(() => ({ contractAddress: config.market, calldata: calldata.map(BigInt) }))
        .execute();
    return submitProved(session, proved.callAndProof, { dryRun });
}

/// Open a leveraged position: withdraw the margin into the leveraged market, then invoke it to book
/// the position. Same shape as a bet, different contract and calldata.
export async function poolOpen(session, config, { calldata, margin, surplusTo }, { dryRun = true } = {}) {
    const proved = await session.transfers
        .build({ autoDiscover: { notes: "refresh", channels: "refresh" }, autoSelectNotes: "all" })
        .with(config.token)
        .withdraw({ recipient: config.leverage, amount: margin })
        .surplusTo(surplusTo)
        .done()
        .invoke(() => ({ contractAddress: config.leverage, calldata: calldata.map(BigInt) }))
        .execute();
    return submitProved(session, proved.callAndProof, { dryRun });
}

/// Close a position to a public address or fire an agent mandate.
///
/// Both are invoke-only from the pool's point of view and the pool refuses an invoke with no note
/// operation (NO_REPLAY_PROTECTION), so a zero-value note transfer rides along to satisfy it. The
/// payout itself leaves the pool to the target address the signature is bound to.
export async function poolInvoke(session, config, { contract, calldata, noteRecipient }, { dryRun = true } = {}) {
    const builder = session.transfers.build({
        autoDiscover: { notes: "refresh", channels: "refresh" },
        autoSelectNotes: "all",
    });
    const withNote =
        noteRecipient && session.Open
            ? builder.with(config.token).transfer({ recipient: noteRecipient, amount: session.Open }).done()
            : builder;
    const proved = await withNote
        .invoke(() => ({ contractAddress: contract, calldata: calldata.map(BigInt) }))
        .execute();
    return submitProved(session, proved.callAndProof, { dryRun });
}

/// The shielded notes this account holds, refreshed from discovery.
export async function notes(session) {
    const discovered = await session.transfers.discoverNotes?.({ refresh: true });
    return discovered ?? [];
}

/// Wait until discovery has indexed at least `expected` notes.
///
/// Deposits must be sequential from the prover's point of view, so firing two in a row without this
/// returns INDEX_NOT_SEQUENTIAL. Polling the index is the only reliable signal; a fixed sleep is a
/// guess that fails under load.
export async function waitForNote(session, expected, { attempts = 20, intervalMs = 3000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const found = await notes(session);
        if (found.length >= expected) return { indexed: true, count: found.length, attempts: attempt + 1 };
        await new Promise((done) => setTimeout(done, intervalMs));
    }
    return { indexed: false, count: (await notes(session)).length, attempts };
}
