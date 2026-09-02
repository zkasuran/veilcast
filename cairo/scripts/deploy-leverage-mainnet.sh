#!/usr/bin/env bash
# Deploy the leveraged market to Starknet mainnet, wired to our sncast wallet, and make it
# demo-ready: declare -> deploy(pool, token) -> seed the vault -> open one leveraged market.
#
#   ./scripts/deploy-leverage-mainnet.sh
#
# SPENDS REAL STRK. The declare is the budget driver and it is larger than it looks.
#
# Measured on 2026-09-02, not projected. The declare consumes a DETERMINISTIC 1,777,666,080 l2 gas,
# identical across three estimator runs, so the amount is a property of the class rather than a padding
# artifact. At the l2 price of the day (33,891,464,126 fri/unit) that is 60.25 STRK of gas which cannot
# be avoided by tuning bounds. `estimateDeclareFee` then pads the PRICE about 1.5x, asking for a 90 STRK
# reserve. Starknet rejects a transaction whose account cannot reserve the full bound even if the
# realized cost would be lower.
#
# So the real requirement is ~90 STRK reserved, of which roughly 60 is actually spent at today's price.
# VeilcastMarket estimated 71.9 and settled at ~35 because the l2 price fell about half between estimate
# and inclusion, which was a market move rather than something to plan around.
#
# Deploy is a few STRK. The vault seed and the market liquidity are recoverable (remove_liquidity, or
# void the market) rather than spent.
#
# The script refuses to start unless the balance covers the whole sequence. A half-finished deploy is
# the expensive failure: the declare is paid for and non-refundable, so running out afterwards leaves
# a class on-chain with nothing deployed against it.
set -euo pipefail

CAIRO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CAIRO_DIR"
ACCOUNTS_FILE="$CAIRO_DIR/../../.wallet/accounts.json"
SN="sncast --accounts-file $ACCOUNTS_FILE --account veilcast"
NET="mainnet"

TOKEN="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"   # STRK
POOL="0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a"     # STRK20 pool
RESOLVER="0x7462cb6bb3f7ea8972e264124d80b68b1ff4c0fa17837d2eaa7216b7108132"   # our OZ account resolves
ONE="1000000000000000000"
VAULT_SEED="${VAULT_SEED:-5000000000000000000}"      # 5 STRK into the vault
MKT_LIQUIDITY="${MKT_LIQUIDITY:-2000000000000000000}" # 2 STRK seeding one market's FPMM
CLOSE_AT="${CLOSE_AT:-$(( $(date -u +%s) + 604800 ))}" # 7 days out

echo "==> tests + build"; snforge test >/dev/null && scarb build >/dev/null

echo "==> preflight: can the deployer afford the whole sequence?"
node - "$ACCOUNTS_FILE" "$VAULT_SEED" "$MKT_LIQUIDITY" <<'PREFLIGHT'
const { RpcProvider, Account, json, hash } = require("starknet");
const fs = require("node:fs");
const [accountsFile, vaultSeed, marketLiquidity] = process.argv.slice(2);
const RPC = process.env.VEILCAST_RPC_URL ?? "https://rpc.starknet.lava.build";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;
const strk = (value) => (Number(value / 10n ** 15n) / 1000).toFixed(3);

(async () => {
    const account = JSON.parse(fs.readFileSync(accountsFile, "utf8"))["alpha-mainnet"].veilcast;
    const provider = new RpcProvider({ nodeUrl: RPC });
    const [low] = await provider.callContract({
        contractAddress: STRK,
        entrypoint: "balanceOf",
        calldata: [account.address],
    });
    const balance = BigInt(low);

    const sierra = json.parse(fs.readFileSync("target/dev/veilcast_LeveragedMarket.contract_class.json", "utf8"));
    const casm = json.parse(fs.readFileSync("target/dev/veilcast_LeveragedMarket.compiled_contract_class.json", "utf8"));
    const signer = new Account({ provider, address: account.address, signer: account.private_key, cairoVersion: "1" });

    // The estimate pads roughly 2x, but budget against the estimate rather than the projection: an
    // underfunded run that dies after the declare has burned the single most expensive step.
    let declareEstimate;
    try {
        const fee = await signer.estimateDeclareFee({ contract: sierra, casm });
        declareEstimate = BigInt(fee.overall_fee);
    } catch (error) {
        if (!String(error.message).includes("already declared")) throw error;
        declareEstimate = 0n;
        console.log("   class already declared, so no declare cost");
    }

    // Deploy, two invokes to seed the vault, one to create a market, then headroom for the real
    // leveraged open through the pool, which carries a proof and costs a few STRK.
    const deployAndCalls = 3n * ONE;
    const openThroughPool = 5n * ONE;
    const needed = declareEstimate + BigInt(vaultSeed) + BigInt(marketLiquidity) + deployAndCalls + openThroughPool;

    console.log(`   balance          ${strk(balance)} STRK`);
    console.log(`   declare estimate ${strk(declareEstimate)} STRK (pads ~2x, so the realized cost is usually about half)`);
    console.log(`   vault seed       ${strk(BigInt(vaultSeed))} STRK (recoverable with remove_liquidity)`);
    console.log(`   market liquidity ${strk(BigInt(marketLiquidity))} STRK (recoverable by voiding the market)`);
    console.log(`   deploy + calls   ${strk(deployAndCalls)} STRK`);
    console.log(`   pool open        ${strk(openThroughPool)} STRK`);
    console.log(`   total needed     ${strk(needed)} STRK`);

    if (balance < needed) {
        console.error(`\n   REFUSING TO START: short by ${strk(needed - balance)} STRK.`);
        console.error(`   Top up ${account.address} then re-run.`);
        console.error(`   Nothing has been spent.`);
        process.exit(1);
    }
    console.log("   affordable, proceeding");
})().catch((error) => {
    console.error("   preflight failed:", error.message);
    process.exit(1);
});
PREFLIGHT

echo "==> declare LeveragedMarket (ignore 'already declared')"
$SN declare --contract-name LeveragedMarket --network "$NET" || true
CLASS=$(scarb build >/dev/null 2>&1; \
  node -e 'const{hash,json}=require("starknet");const fs=require("fs");const s=json.parse(fs.readFileSync("target/dev/veilcast_LeveragedMarket.contract_class.json","utf8"));console.log(hash.computeContractClassHash(s))')
echo "CLASS=$CLASS"
echo "==> deploy LeveragedMarket(pool, token)"
LEV=$($SN deploy --network "$NET" --class-hash "$CLASS" --constructor-calldata "$POOL" "$TOKEN" \
      | tee /dev/stderr | grep -oE 'contract_address: 0x[0-9a-fA-F]+' | grep -oE '0x[0-9a-fA-F]+')
echo "LEVERAGE=$LEV"

echo "==> seed the vault: approve then add_liquidity($VAULT_SEED)"
$SN invoke --network "$NET" --contract-address "$TOKEN" --function approve \
   --calldata "$LEV" "$VAULT_SEED" "0"
$SN invoke --network "$NET" --contract-address "$LEV" --function add_liquidity --calldata "$VAULT_SEED"

echo "==> open one leveraged market (resolver=us, close in 7d, seed $MKT_LIQUIDITY)"
$SN invoke --network "$NET" --contract-address "$LEV" --function create_market \
   --calldata "$RESOLVER" "$CLOSE_AT" "$MKT_LIQUIDITY"

cat >> "$CAIRO_DIR/address.md" <<EOF

# Leveraged market ($(date -u +%FT%TZ))
LeveragedMarket   $LEV
class_hash        $CLASS
vault_seed        $VAULT_SEED
EOF

cat <<EOF

Done. Add to veilcast/.env.local and the GitHub Pages env:
  NEXT_PUBLIC_VEILCAST_LEVERAGE_MAINNET=$LEV
Then add {"name":"LeveragedMarket","address":"$LEV","network":"mainnet","class_hash":"$CLASS"}
to strk20.json contracts[], and open a real leveraged position through the pool
(reuse the OHTTP open path; openActions builds the withdraw + Open invoke).
EOF

