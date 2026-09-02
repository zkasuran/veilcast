// Move STRK from the deployer to a tester account so it can shield and bet.
//
// An ordinary ERC-20 transfer. It carries no pool event and no event of ours, so it does not count
// toward the program's three; it is plumbing for the two bets that do.
//
//   node scripts/fund.mjs tester2 9            # estimate only
//   node scripts/fund.mjs tester2 9 --confirm  # sends
import { Account, RpcProvider, CallData, uint256 } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ACCOUNTS = new URL("../../../.wallet/accounts.json", import.meta.url).pathname;

const [, , target, amountStrk] = process.argv;
const CONFIRM = process.argv.includes("--confirm");
if (!target || !amountStrk) {
    console.error("usage: node scripts/fund.mjs <accountName> <amountStrk> [--confirm]");
    process.exit(4);
}
const amount = BigInt(Math.round(Number(amountStrk) * 1e6)) * 10n ** 12n;

const provider = new RpcProvider({ nodeUrl: RPC });
const all = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"];
const from = all.veilcast;
const to = all[target];
if (!to) {
    console.error(`no account named ${target}. have: ${Object.keys(all).join(", ")}`);
    process.exit(4);
}
const signer = new Account({ provider, address: from.address, signer: from.private_key, cairoVersion: "1" });
const strk = (v) => (Number(BigInt(v) / 10n ** 13n) / 100_000).toFixed(5);
const balance = async (address) =>
    BigInt((await provider.callContract({ contractAddress: STRK, entrypoint: "balanceOf", calldata: [address] }))[0]);

console.log(`from ${from.address} (${strk(await balance(from.address))} STRK)`);
console.log(`to   ${to.address} (${strk(await balance(to.address))} STRK)`);
console.log(`send ${strk(amount)} STRK`);

const call = {
    contractAddress: STRK,
    entrypoint: "transfer",
    calldata: CallData.compile([to.address, uint256.bnToUint256(amount)]),
};
console.log(`estimate: ${strk((await signer.estimateInvokeFee([call])).overall_fee)} STRK gas`);
if (!CONFIRM) {
    console.log("dry run. re-run with --confirm to send.");
    process.exit(0);
}
const tx = await signer.execute([call]);
console.log(`tx: ${tx.transaction_hash}`);
const receipt = await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 3000 });
console.log(`execution_status: ${receipt.execution_status ?? receipt.value?.execution_status}`);
console.log(`${target} now holds ${strk(await balance(to.address))} STRK`);
