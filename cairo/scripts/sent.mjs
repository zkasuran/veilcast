// Every transaction this account sent in a block window, including reverted ones.
//
// A reverted transaction emits no events, so an event-log scan cannot see it. When STRK left an account
// and nothing shows up in the pool's log, the fee was paid by a revert and the reason is on the receipt.
//
//   node scripts/sent.mjs <accountName> [blocksBack]
import { RpcProvider } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const ACCOUNTS = new URL("../../../.wallet/accounts.json", import.meta.url).pathname;
const name = process.argv[2] ?? "tester2";
const back = Number(process.argv[3] ?? 150);
const norm = (a) => String(a).replace(/^0x0*/, "").toLowerCase();

const provider = new RpcProvider({ nodeUrl: RPC });
const acc = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"][name];
const head = (await provider.getBlockLatestAccepted()).block_number;
const nonce = await provider.getNonceForAddress(acc.address);
console.log(`account ${name} ${acc.address}  nonce ${BigInt(nonce)}  scanning ${head - back}..${head}`);

for (let b = head; b >= head - back; b--) {
    const block = await provider.getBlockWithTxs(b).catch(() => null);
    for (const tx of block?.transactions ?? []) {
        if (norm(tx.sender_address ?? "") !== norm(acc.address)) continue;
        const receipt = await provider.getTransactionReceipt(tx.transaction_hash).catch(() => null);
        const status = receipt?.execution_status ?? receipt?.value?.execution_status;
        const reason = receipt?.revert_reason ?? receipt?.value?.revert_reason;
        console.log(`\nblock ${b}  ${tx.transaction_hash}  ${status}`);
        if (reason) console.log(`  revert: ${String(reason).slice(0, 600)}`);
    }
}
