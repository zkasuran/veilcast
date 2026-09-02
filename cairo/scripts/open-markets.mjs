// Open fresh markets on the live mainnet VeilcastMarket with close times in the future.
//
// Every market on the board is past its close_at. do_bet asserts
// get_block_timestamp() < market.close_at, so no bet can land until a new one exists. This is an
// ordinary public invoke from our own account rather than a pool action, so it carries no proof and
// no pool event: it does not count toward the program's three itself, it is what makes the bets that
// do count possible.
//
//   node scripts/open-markets.mjs            # estimate only, sends nothing
//   node scripts/open-markets.mjs --confirm  # sends
import { Account, RpcProvider, byteArray, CallData } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const MARKET = "0x036be78d67d6e94b79d3a8a7891b67871d4f17342d4c323be8f6ed469c36c6b8";
const RESOLVER = "0x7462cb6bb3f7ea8972e264124d80b68b1ff4c0fa17837d2eaa7216b7108132";
const ACCOUNTS = new URL("../../../.wallet/accounts.json", import.meta.url).pathname;
const CONFIRM = process.argv.includes("--confirm");
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

const MARKETS = [
    {
        question: "Will Starknet mainnet exceed 1,000,000 transactions in the week ending 2026-10-01?",
        labels: ["Yes", "No"],
        closeAt: now + 28 * DAY,
        category: "starknet",
    },
    {
        question: "Will ETH close above $4,000 on 2026-10-15 (UTC)?",
        labels: ["Yes", "No"],
        closeAt: now + 42 * DAY,
        category: "crypto",
    },
];

const provider = new RpcProvider({ nodeUrl: RPC });
const acc = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"].veilcast;
const signer = new Account({ provider, address: acc.address, signer: acc.private_key, cairoVersion: "1" });

// create_market(question, outcome_labels, resolver, close_at, category, fee_bps, fee_recipient) -> u64.
// Zero fee, so the contract stores a zero fee_recipient regardless of what we pass.
const calls = MARKETS.map((m) => ({
    contractAddress: MARKET,
    entrypoint: "create_market",
    calldata: CallData.compile([
        byteArray.byteArrayFromString(m.question),
        m.labels.map((l) => byteArray.byteArrayFromString(l)),
        RESOLVER,
        m.closeAt,
        m.category,
        0,
        "0x0",
    ]),
}));

const strk = (v) => (Number(BigInt(v) / 10n ** 13n) / 100_000).toFixed(5);
const before = Number((await provider.callContract({ contractAddress: MARKET, entrypoint: "get_n_markets", calldata: [] }))[0]);
console.log(`n_markets before: ${before}`);
for (const m of MARKETS) console.log(`  closes ${new Date(m.closeAt * 1000).toISOString()}  ${m.question}`);

const fee = await signer.estimateInvokeFee(calls);
console.log(`estimate: ${strk(fee.overall_fee)} STRK for both, one transaction`);

if (!CONFIRM) {
    console.log("dry run. re-run with --confirm to send.");
    process.exit(0);
}

const tx = await signer.execute(calls);
console.log(`tx: ${tx.transaction_hash}`);
const receipt = await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 3000 });
console.log(`execution_status: ${receipt.execution_status ?? receipt.value?.execution_status}`);
const after = Number((await provider.callContract({ contractAddress: MARKET, entrypoint: "get_n_markets", calldata: [] }))[0]);
console.log(`n_markets after: ${after}  (new ids ${before}..${after - 1})`);
fs.writeFileSync("/tmp/veilcast-new-markets.json", JSON.stringify({ tx: tx.transaction_hash, firstId: before, lastId: after - 1 }));
