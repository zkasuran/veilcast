// What did this account actually land recently? Read-only.
//
// A run that dies after submitting leaves real transactions on chain and no local record of them, so
// recover the hashes from the pool's own event log rather than trusting a script's stdout.
//
//   node scripts/recent.mjs <accountName> [blocksBack]
import { RpcProvider } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const MARKET = "0x036be78d67d6e94b79d3a8a7891b67871d4f17342d4c323be8f6ed469c36c6b8";
const ACCOUNTS = new URL("../../../.wallet/accounts.json", import.meta.url).pathname;

const name = process.argv[2] ?? "tester2";
const back = Number(process.argv[3] ?? 400);
const norm = (a) => String(a).replace(/^0x0*/, "").toLowerCase();
const provider = new RpcProvider({ nodeUrl: RPC });
const acc = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"][name];
const head = (await provider.getBlockLatestAccepted()).block_number;

const seen = new Map();
for (const address of [POOL, MARKET]) {
    let token;
    do {
        const page = await provider.getEvents({
            address,
            from_block: { block_number: head - back },
            to_block: { block_number: head },
            chunk_size: 1000,
            ...(token ? { continuation_token: token } : {}),
        });
        for (const e of page.events ?? []) {
            const row = seen.get(e.transaction_hash) ?? { pool: false, market: false, block: e.block_number };
            if (norm(address) === norm(POOL)) row.pool = true;
            else row.market = true;
            seen.set(e.transaction_hash, row);
        }
        token = page.continuation_token;
    } while (token);
}

const mine = [];
for (const [txHash, row] of seen) {
    const tx = await provider.getTransaction(txHash).catch(() => null);
    const sender = tx?.sender_address ?? tx?.contract_address;
    if (sender && norm(sender) === norm(acc.address)) {
        const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
        mine.push({
            txHash,
            block: row.block,
            status: receipt?.execution_status ?? receipt?.value?.execution_status,
            pool: row.pool,
            market: row.market,
            counts: row.pool && row.market,
        });
    }
}
mine.sort((a, b) => a.block - b.block);
console.log(JSON.stringify({ account: name, address: acc.address, head, scanned: `${head - back}..${head}`, found: mine }, null, 1));
