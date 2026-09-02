// Place one private bet on the live mainnet board, through the STRK20 pool, then prove what it carried.
//
// This is the transaction that counts under the program's rule: the pool withdraws the stake and
// invokes VeilcastMarket in the same proof-carrying call, so the receipt carries a pool event and a
// VeilcastMarket event. A shield alone carries only the former.
//
// The rules encoded here were each learned from a failure, so do not simplify them away:
//   - the viewing key is poseidon([privateKey]) mod (n/2), never the raw key
//   - prove against head-15, because a fresher block is not yet in the prover's view
//   - submit the proof-carrying call on its own, with proofFacts and proof passed to execute
//   - deposit first if the account holds no notes, then wait for the note to index before spending it
//   - the position is a fresh keypair; the coupon is the only way back to the winnings
//
//   node scripts/mainnet-bet.mjs --account tester2 --market 3 --outcome 0 --stake 0.5 --deposit 1
//   ... --confirm     to actually send
import { createPrivateTransfers, IndexerDiscoveryProvider } from "../../../starknet-privacy/sdk/dist/index.js";
import { Account, RpcProvider, constants, hash, ec, stark } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const MARKET = "0x036be78d67d6e94b79d3a8a7891b67871d4f17342d4c323be8f6ed469c36c6b8";
const PROVING = "https://cloud.argent-api.com/v1/privacy/proving";
const DISCOVERY = "https://cloud.argent-api.com/v1/privacy/discovery";
const ACCOUNTS = new URL("../../../.wallet/accounts.json", import.meta.url).pathname;

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};
const CONFIRM = process.argv.includes("--confirm");
const ACCOUNT = arg("account", "tester2");
const MARKET_ID = Number(arg("market", "3"));
const OUTCOME = Number(arg("outcome", "0"));
const toWei = (v) => BigInt(Math.round(Number(v) * 1e6)) * 10n ** 12n;
const STAKE = toWei(arg("stake", "0.5"));
const DEPOSIT = arg("deposit") ? toWei(arg("deposit")) : 0n;

const strk = (v) => (Number(BigInt(v) / 10n ** 13n) / 100_000).toFixed(5);
const norm = (a) => String(a).replace(/^0x0*/, "").toLowerCase();
const provider = new RpcProvider({ nodeUrl: RPC });
const acc = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"][ACCOUNT];
const wallet = new Account({ provider, address: acc.address, signer: acc.private_key, cairoVersion: "1" });

// The canonical viewing key. A raw private key here produces notes nobody can find again.
const n = ec.starkCurve.CURVE.n;
let vk = BigInt(hash.computePoseidonHashOnElements([acc.private_key])) % (n / 2n);
if (vk === 0n) vk = 1n;
const discovery = new IndexerDiscoveryProvider(DISCOVERY, POOL, { ohttp: true });
const transfers = async () =>
    createPrivateTransfers({
        account: wallet,
        viewingKeyProvider: { getViewingKey: async () => vk },
        provingProvider: {
            url: PROVING,
            chainId: constants.StarknetChainId.SN_MAIN,
            ohttp: true,
            nodeUrl: RPC,
            blockIdentifier: (await provider.getBlockLatestAccepted()).block_number - 15,
        },
        discoveryProvider: discovery,
        poolContractAddress: POOL,
    });

/// The one line that says why, dug out of a Starknet RPC error.
///
/// These errors nest: the account's failure wraps the pool's, which wraps the Cairo string. The outer
/// message is always the useless "Transaction execution error". The payload also carries the whole
/// signed transaction including megabytes of proof, so printing the error is worse than printing
/// nothing. Walk to the deepest `error` and show that.
function why(error) {
    let node = error?.baseError?.data ?? error?.baseError ?? error;
    let deepest = node?.message ?? String(error?.message ?? error);
    for (let depth = 0; depth < 12 && node; depth++) {
        const inner = node.execution_error ?? node.error;
        if (inner === undefined) break;
        if (typeof inner === "string") {
            deepest = inner;
            break;
        }
        node = inner;
        if (typeof node === "object" && typeof node.error === "string") deepest = node.error;
    }
    return String(deepest).replace(/\\?"/g, "").slice(0, 300);
}
async function carried(txHash) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
        const events = receipt?.events ?? receipt?.value?.events;
        if (events) {
            const from = events.map((e) => norm(e.from_address));
            return { pool: from.includes(norm(POOL)), market: from.includes(norm(MARKET)), events: from.length };
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return { pool: null, market: null };
}

console.log(`account   ${ACCOUNT} ${acc.address}`);
console.log(`market    #${MARKET_ID} outcome ${OUTCOME}`);
console.log(`stake     ${strk(STAKE)} STRK` + (DEPOSIT ? `, shielding ${strk(DEPOSIT)} first` : ""));
if (!CONFIRM) {
    console.log("dry run. re-run with --confirm to send.");
    process.exit(0);
}

const landed = [];

if (DEPOSIT > 0n) {
    const deposit = await (await transfers())
        .build({ autoRegister: true, autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } })
        .with(STRK)
        .deposit({ amount: DEPOSIT })
        .execute();
    const tx = await wallet.execute([deposit.callAndProof.call], {
        proofFacts: deposit.callAndProof.proof.proofFacts,
        proof: deposit.callAndProof.proof.data,
    });
    console.log(`shield tx  ${tx.transaction_hash}`);
    await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 3000 });
    console.log(`  carried  ${JSON.stringify(await carried(tx.transaction_hash))}`);
    landed.push({ kind: "shield", txHash: tx.transaction_hash });
    // The note has to be indexed before it can be spent. Discovery lags the block.
    console.log("  waiting 30s for the note to index");
    await new Promise((r) => setTimeout(r, 30_000));
}

// The position is a fresh keypair. Whoever holds it owns the winnings, which is what keeps the bettor
// unlinkable to the bet.
const positionPrivate = stark.randomAddress();
const positionKey = ec.starkCurve.getStarkKey(positionPrivate);
const couponPath = `/tmp/veilcast-coupon-m${MARKET_ID}-o${OUTCOME}.json`;
fs.writeFileSync(
    couponPath,
    JSON.stringify({ marketId: MARKET_ID, outcome: OUTCOME, amount: STAKE.toString(), privateKey: positionPrivate, positionKey })
);
console.log(`coupon    ${couponPath}`);

const bet = await (await transfers())
    .build({ autoDiscover: { notes: "refresh", channels: "refresh" }, autoSelectNotes: "all" })
    .with(STRK)
    .withdraw({ recipient: MARKET, amount: STAKE })
    .surplusTo(acc.address)
    .done()
    // place_bet(caller_is_pool_flag, market_id, outcome, amount, position_key)
    .invoke(() => ({
        contractAddress: MARKET,
        calldata: [0n, BigInt(MARKET_ID), BigInt(OUTCOME), STAKE, BigInt(positionKey)],
    }))
    .execute()
    // A failure here carries the whole signed payload, proof bytes and all, which buries the one line
    // that says why. Keep the reason and throw the rest away.
    .catch((error) => {
        console.error(`prove/build failed: ${why(error)}`);
        process.exit(5);
    });
const tx = await wallet
    .execute([bet.callAndProof.call], {
        proofFacts: bet.callAndProof.proof.proofFacts,
        proof: bet.callAndProof.proof.data,
    })
    .catch((error) => {
        console.error(`submit failed: ${why(error)}`);
        process.exit(5);
    });
console.log(`bet tx     ${tx.transaction_hash}`);
const receipt = await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 3000 });
console.log(`  status   ${receipt.execution_status ?? receipt.value?.execution_status}`);
const facts = await carried(tx.transaction_hash);
console.log(`  carried  ${JSON.stringify(facts)}`);
console.log(`  counts   ${facts.pool && facts.market ? "YES" : "NO"}`);
landed.push({ kind: "bet", txHash: tx.transaction_hash, ...facts });

fs.appendFileSync("/tmp/veilcast-mainnet-txs.jsonl", landed.map((l) => JSON.stringify(l)).join("\n") + "\n");
