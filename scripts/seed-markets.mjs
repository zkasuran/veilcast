// Seed real prediction markets on the deployed mainnet VeilcastMarket.
// create_market is open to anyone (not pool-gated); it is a plain Starknet invoke
// from our account, so it needs no STRK20 prover. Run: node scripts/seed-markets.mjs
import fs from "node:fs";
import { Account, Contract, RpcProvider, shortString } from "starknet";

const RPC = "https://rpc.starknet.lava.build";
const MARKET = "0x036be78d67d6e94b79d3a8a7891b67871d4f17342d4c323be8f6ed469c36c6b8";
const acc = JSON.parse(fs.readFileSync(new URL("../../.wallet/accounts.json", import.meta.url)))["alpha-mainnet"]["veilcast"];
const abi = JSON.parse(fs.readFileSync(new URL("../src/abi/veilcastMarket.json", import.meta.url)));

const provider = new RpcProvider({ nodeUrl: RPC });
const account = new Account({ provider, address: acc.address, signer: acc.private_key, cairoVersion: "1" });
const market = new Contract({ abi, address: MARKET, providerOrAccount: account });

const now = Math.floor(Date.now() / 1000);
const day = 86400;
const ZERO = "0x0";
const specs = [
  { q: "Will STRK trade above $0.20 on 2026-09-30?", outs: ["Yes", "No"], close: now + 6 * day, cat: "Crypto" },
  { q: "Will Bitcoin set a new all-time high before 2026-10-01?", outs: ["Yes", "No"], close: now + 5 * day, cat: "Crypto" },
  { q: "Which team wins the 2026 hackathon grand prize?", outs: ["Veilcast", "A rival", "No award"], close: now + 4 * day, cat: "Meta" },
];

const created = [];
for (const s of specs) {
  const call = market.populate("create_market", [
    s.q, s.outs, acc.address /* resolver = us */, s.close, shortString.encodeShortString(s.cat), 0 /* fee_bps */, ZERO,
  ]);
  const { transaction_hash } = await account.execute(call);
  console.log(`create_market "${s.q.slice(0, 40)}..." -> ${transaction_hash}`);
  const rec = await provider.waitForTransaction(transaction_hash);
  console.log(`  ${rec.execution_status ?? rec.finality_status}`);
  created.push(transaction_hash);
}
const n = await market.get_n_markets();
console.log("total markets on-chain:", n.toString());
console.log("SEED_TXS=" + created.join(","));
