// Read-only: who we have, what they hold and what the live market board looks like.
// Free. No transaction. Run before spending anything.
import { RpcProvider } from "starknet";
import fs from "node:fs";

const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const MARKET = "0x1cd1ff4b1a1de9c9d1e2e1e0e9d0f4e2a";
const ACCOUNTS = "/home/asuran/Downloads/hackathon-hq/work/strk20/.wallet/accounts.json";

const provider = new RpcProvider({ nodeUrl: RPC });
const strk = (v) => (Number(v / 10n ** 14n) / 10000).toFixed(4);

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8"))["alpha-mainnet"];
const rows = [];
for (const [name, a] of Object.entries(accounts)) {
    const [low] = await provider.callContract({
        contractAddress: STRK,
        entrypoint: "balanceOf",
        calldata: [a.address],
    });
    rows.push({ name, address: a.address, strk: strk(BigInt(low)) });
}
console.log(JSON.stringify({ rpc: RPC, accounts: rows }, null, 2));
