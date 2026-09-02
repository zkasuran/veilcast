#!/usr/bin/env bash
# Everything after the LeveragedMarket deploy lands, in one command.
#
#   ./scripts/post-deploy.sh 0x<leverageAddress>
#
# Takes the address the deploy printed and finishes the submission: records it in strk20.json,
# verifies every claim in that file against chain, sets the GitHub variable the Pages build reads so
# the live site stops saying "not deployed", then reports which agent verbs are now live.
#
# Idempotent and safe to re-run. It sends no transactions of its own, so nothing here spends STRK.
set -euo pipefail

LEV="${1:-}"
if [[ ! "$LEV" =~ ^0x[0-9a-fA-F]+$ ]]; then
    echo "usage: $0 0x<leverageAddress>" >&2
    echo "  the address the deploy printed as LEVERAGE=" >&2
    exit 1
fi

# The paths below are repo-root relative (cairo/target, strk20.json), so resolve to the repo root rather
# than to cairo/. dirname/.. is the cairo directory, so this needs one more level up.
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

echo "==> 1. confirm the class deployed at that address is the one we built"
node - "$LEV" <<'CHECK'
const { RpcProvider, hash, json } = require("starknet");
const fs = require("node:fs");
const [address] = process.argv.slice(2);
const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
(async () => {
    const provider = new RpcProvider({ nodeUrl: RPC });
    const onChain = await provider.getClassHashAt(address);
    const sierra = json.parse(
        fs.readFileSync("cairo/target/dev/veilcast_LeveragedMarket.contract_class.json", "utf8")
    );
    const local = hash.computeContractClassHash(sierra);
    console.log(`   on-chain ${onChain}`);
    console.log(`   local    ${local}`);
    if (BigInt(onChain) !== BigInt(local)) {
        console.error("   MISMATCH: that address does not hold the class in this working tree.");
        console.error("   Refusing to record a claim we cannot back. Rebuild or check the address.");
        process.exit(1);
    }
    console.log("   match");
})().catch((error) => {
    console.error("   check failed:", error.message);
    process.exit(1);
});
CHECK

echo "==> 2. record it in strk20.json"
node - "$LEV" <<'RECORD'
const { RpcProvider, hash, json } = require("starknet");
const fs = require("node:fs");
const [address] = process.argv.slice(2);
const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
(async () => {
    const provider = new RpcProvider({ nodeUrl: RPC });
    const classHash = await provider.getClassHashAt(address);
    const manifest = JSON.parse(fs.readFileSync("strk20.json", "utf8"));
    manifest.contracts = manifest.contracts.filter((entry) => entry.name !== "LeveragedMarket");
    manifest.contracts.push({
        name: "LeveragedMarket",
        address,
        network: "mainnet",
        class_hash: classHash,
    });
    fs.writeFileSync("strk20.json", `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`   recorded LeveragedMarket ${address}`);
    console.log(`   contracts now: ${manifest.contracts.map((entry) => entry.name).join(", ")}`);
})().catch((error) => {
    console.error("   record failed:", error.message);
    process.exit(1);
});
RECORD

echo "==> 3. re-derive every recorded claim straight from chain"
node agent/cli.mjs verify --file strk20.json | tee /tmp/verify-after-deploy.json | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("   verdict:",r.ok?"ALL PASS":"FAILURES");console.log("  ",JSON.stringify(r.data.summary));if(!r.ok)process.exit(1);})'

echo "==> 4. point the live site at it"
if command -v gh >/dev/null 2>&1; then
    gh variable set VEILCAST_LEVERAGE_MAINNET --body "$LEV" 2>/dev/null \
        && echo "   set repo variable VEILCAST_LEVERAGE_MAINNET" \
        || echo "   could not set the variable; run: gh variable set VEILCAST_LEVERAGE_MAINNET --body $LEV"
else
    echo "   gh not available; run: gh variable set VEILCAST_LEVERAGE_MAINNET --body $LEV"
fi
echo "   the next Pages build reads it, so the Leverage tab stops saying 'not deployed'"

echo "==> 5. which agent verbs are live now"
VEILCAST_LEVERAGE="$LEV" node agent/cli.mjs status | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const c=r.data;console.log("   leverageDeployed:",c.contracts.leverageDeployed);console.log("   solvent:",c.solvency?c.solvency.solvent:"n/a");console.log("   capabilities:",JSON.stringify(c.capabilities));})'

VEILCAST_LEVERAGE="$LEV" node agent/cli.mjs lev-markets | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("   markets on the leveraged board:",r.data.count);for(const m of r.data.markets)console.log(`     #${m.id} ${m.state} YES ${(m.yesPriceBps/100).toFixed(1)}% NO ${(m.noPriceBps/100).toFixed(1)}%`);})'

cat <<DONE

==> post-deploy complete

  Recorded and verified. Remaining, in order:
   1. export VEILCAST_LEVERAGE=$LEV
   2. open a real leveraged position through the pool:
        node agent/cli.mjs lev-open --market 0 --side yes --margin 1 --leverage 2x \\
          --accounts ../.wallet/accounts.json --account veilcast          # dry run first
      then re-run with --confirm and add the tx hash to strk20.json transactions[]
   3. commit and push, then confirm the Pages build picked up the variable
   4. the demo video
DONE
