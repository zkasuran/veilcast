#!/usr/bin/env bash
# Declare and deploy VeilcastMarket against the live STRK20 privacy pool.
#
# The market is bound to one pool and one token at construction and neither can be changed
# afterwards, so the addresses below are the whole configuration. Nothing else about the contract is
# network-specific.
#
# One-time setup (needs a funded account; the key never leaves your machine):
#   sncast account import --name veilcast --address <account> --private-key <key> \
#       --type <oz|argent|braavos> --network <sepolia|mainnet>
#
# Usage:
#   ./scripts/deploy.sh sepolia          # VEILCAST_POOL must be set: the pool on Sepolia
#   ./scripts/deploy.sh mainnet          # pool address below is the verified mainnet one
#
# Deploying costs a real fee and mainnet spends real STRK. Read the output before you rerun it: a
# second run declares nothing new but does deploy a second, empty market.
set -euo pipefail

NETWORK="${1:?usage: deploy.sh sepolia|mainnet}"
ACCOUNT="${SNCAST_ACCOUNT:-veilcast}"

# STRK, the token every market is denominated in. Same address on both networks.
TOKEN="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"

case "$NETWORK" in
    mainnet)
        # Verified against the live network, from the sprint's day-0 doc.
        POOL="${VEILCAST_POOL:-0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a}"
        # Pragma's own oracle. Read live on 2026-08-16: STRK/USD, 12 publishers, 8 decimals.
        ORACLE="${VEILCAST_ORACLE:-0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b}"
        # An hour is generous for a feed that updates every few minutes.
        MAX_PRICE_AGE="${VEILCAST_MAX_PRICE_AGE:-3600}"
        ;;
    sepolia)
        # The Sepolia pool address is not published in the sprint docs, so it has to be passed in.
        POOL="${VEILCAST_POOL:?set VEILCAST_POOL to the STRK20 pool address on Sepolia}"
        ORACLE="${VEILCAST_ORACLE:-0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a}"
        # The Sepolia feed goes months between updates, so a strict window would settle nothing.
        MAX_PRICE_AGE="${VEILCAST_MAX_PRICE_AGE:-31536000}"
        ;;
    *)
        echo "unknown network: $NETWORK (expected sepolia or mainnet)" >&2
        exit 1
        ;;
esac

cd "$(dirname "$0")/.."

echo "==> tests"
snforge test

echo "==> build"
scarb build

echo "==> declare on $NETWORK"
# A class that is already declared makes this fail; that is fine, take the hash from the error.
sncast --account "$ACCOUNT" declare --contract-name VeilcastMarket --network "$NETWORK"
sncast --account "$ACCOUNT" declare --contract-name PragmaResolver --network "$NETWORK"

NETWORK_UPPER=$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')

cat <<EOF

Take the class hashes printed above. Deploy the market first, bound to the pool and the token:

  sncast --account $ACCOUNT deploy --network $NETWORK \\
      --class-hash <VeilcastMarket class hash> \\
      --constructor-calldata $POOL $TOKEN

Then, optionally, the Pragma resolver, bound to that market and to the feed:

  sncast --account $ACCOUNT deploy --network $NETWORK \\
      --class-hash <PragmaResolver class hash> \\
      --constructor-calldata <market address> $ORACLE $MAX_PRICE_AGE

Record both in cairo/address.md, in strk20.json at the repo root and in .env.local as
NEXT_PUBLIC_VEILCAST_MARKET_$NETWORK_UPPER and NEXT_PUBLIC_VEILCAST_RESOLVER_$NETWORK_UPPER.
EOF
