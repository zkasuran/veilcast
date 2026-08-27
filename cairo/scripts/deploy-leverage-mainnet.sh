#!/usr/bin/env bash
# Deploy the leveraged market to Starknet mainnet, wired to our sncast wallet, and make it
# demo-ready: declare -> deploy(pool, token) -> seed the vault -> open one leveraged market.
#
#   ./scripts/deploy-leverage-mainnet.sh
#
# SPENDS REAL STRK. Declare is the budget driver (estimate ~81 STRK padded, market declare
# realized at about half its estimate). Deploy is a few STRK; the vault seed and the market
# liquidity are recoverable (remove_liquidity / void), not spent.
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

echo "==> declare LeveragedMarket (ignore 'already declared')"
$SN declare --contract-name LeveragedMarket --network "$NET" || true
CLASS=$(scarb build >/dev/null 2>&1; \
  node -e 'const{hash,json}=require("starknet");const fs=require("fs");const s=json.parse(fs.readFileSync("target/dev/veilcast_LeveragedMarket.contract_class.json","utf8"));console.log(hash.computeContractClassHash(s))')
echo "CLASS=$CLASS"
# PLACEHOLDER_DEPLOY
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

