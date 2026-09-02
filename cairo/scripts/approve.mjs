// Approve the STRK20 pool to pull STRK from an account.
//
// A pool deposit is a proof-carrying single call, so the allowance cannot ride along inside it: the
// approve has to be its own ordinary transaction, sent first. Skipping it fails the deposit with
// "Insufficient ERC20 allowance" at estimate time, before anything is spent.
//
//   node scripts/approve.mjs tester2 20 --confirm
import { Account, RpcProvider, CallData, uint256 } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const ACCOUNTS = new URL("../../../.wallet/accounts.json", import.meta.url).pathname;

const name = process.argv[2] ?? "tester2";
const amount = BigInt(Math.round(Number(process.argv[3] ?? "20") * 1e6)) * 10n ** 12n;
const CONFIRM = process.argv.includes("--confirm");

const provider = new RpcProvider({ nodeUrl: RPC });
const acc = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"][name];
const signer = new Account({ provider, address: acc.address, signer: acc.private_key, cairoVersion: "1" });
const strk = (v) => (Number(BigInt(v) / 10n ** 13n) / 100_000).toFixed(5);

const [low] = await provider.callContract({
    contractAddress: STRK,
    entrypoint: "allowance",
    calldata: [acc.address, POOL],
});
console.log(`${name} allowance to pool: ${strk(low)} STRK, setting ${strk(amount)}`);
if (!CONFIRM) {
    console.log("dry run. re-run with --confirm to send.");
    process.exit(0);
}
const tx = await signer.execute([
    { contractAddress: STRK, entrypoint: "approve", calldata: CallData.compile([POOL, uint256.bnToUint256(amount)]) },
]);
console.log(`tx: ${tx.transaction_hash}`);
const receipt = await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 3000 });
console.log(`execution_status: ${receipt.execution_status ?? receipt.value?.execution_status}`);
