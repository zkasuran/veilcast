#!/usr/bin/env bash
# Fully automated mainnet deploy for Veilcast, wired to our sncast wallet.
# Fires the instant the account is funded. Deploys account -> declares 3 classes ->
# deploys market, pragma resolver, committee resolver -> writes addresses out.
#
#   ./scripts/deploy-mainnet-auto.sh
#
# Spends real STRK. Account deploy ~0.08, each declare+deploy a few STRK.
set -euo pipefail

CAIRO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CAIRO_DIR"
ACCOUNTS_FILE="$CAIRO_DIR/../../.wallet/accounts.json"   # work/strk20/.wallet/accounts.json
SN="sncast --accounts-file $ACCOUNTS_FILE --account veilcast"
NET="mainnet"

TOKEN="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"   # STRK
POOL="0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a"     # STRK20 pool
ORACLE="0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b"    # Pragma STRK/USD
MAX_PRICE_AGE="3600"
MKT_CLASS="0x72f580f16a5715f46f31cd462ca074cf18ad3b8f1e7486582ed429f6760c8b0"
PRG_CLASS="0x2f83ee8cdb0d4ece2fb1b17b613dd53ec79f8a7236e393dfb987aed46b4385a"
CMT_CLASS="0x7b68de12c92f739db96e0682acc439c0b3d77400fae34d455835a18bba15d78"

echo "==> tests + build"; snforge test >/dev/null && scarb build >/dev/null

echo "==> deploy account (idempotent; ignore 'already deployed')"
$SN account deploy --network "$NET" --name veilcast || true

echo "==> declare classes (ignore 'already declared')"
for c in VeilcastMarket PragmaResolver CommitteeResolver; do
  $SN declare --contract-name "$c" --network "$NET" || true
done

echo "==> deploy VeilcastMarket(pool, token)"
MKT=$($SN deploy --network "$NET" --class-hash "$MKT_CLASS" --constructor-calldata "$POOL" "$TOKEN" \
      | tee /dev/stderr | grep -oE 'contract_address: 0x[0-9a-fA-F]+' | grep -oE '0x[0-9a-fA-F]+')
echo "MARKET=$MKT"

echo "==> deploy PragmaResolver(market, oracle, max_age)"
PRG=$($SN deploy --network "$NET" --class-hash "$PRG_CLASS" --constructor-calldata "$MKT" "$ORACLE" "$MAX_PRICE_AGE" \
      | tee /dev/stderr | grep -oE 'contract_address: 0x[0-9a-fA-F]+' | grep -oE '0x[0-9a-fA-F]+')
echo "PRAGMA=$PRG"

echo "==> deploy CommitteeResolver(market)"
CMT=$($SN deploy --network "$NET" --class-hash "$CMT_CLASS" --constructor-calldata "$MKT" \
      | tee /dev/stderr | grep -oE 'contract_address: 0x[0-9a-fA-F]+' | grep -oE '0x[0-9a-fA-F]+')
echo "COMMITTEE=$CMT"

cat > "$CAIRO_DIR/address.md" <<EOF
# Veilcast mainnet deployment ($(date -u +%FT%TZ))
VeilcastMarket    $MKT
PragmaResolver    $PRG
CommitteeResolver $CMT
pool  $POOL
token $TOKEN
oracle $ORACLE
EOF

cat <<EOF

Done. Add to veilcast/.env.local:
  NEXT_PUBLIC_VEILCAST_MARKET_MAINNET=$MKT
  NEXT_PUBLIC_VEILCAST_RESOLVER_MAINNET=$PRG
  NEXT_PUBLIC_VEILCAST_COMMITTEE_MAINNET=$CMT
And into strk20.json contracts[].
EOF
