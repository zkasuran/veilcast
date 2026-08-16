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
        ;;
    sepolia)
        # The Sepolia pool address is not published in the sprint docs, so it has to be passed in.
        POOL="${VEILCAST_POOL:?set VEILCAST_POOL to the STRK20 pool address on Sepolia}"
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

echo
echo "Take the class hash printed above, then deploy the market bound to the pool and the token:"
echo
echo "  sncast --account $ACCOUNT deploy --network $NETWORK \\"
echo "      --class-hash <class_hash> \\"
echo "      --constructor-calldata $POOL $TOKEN"
echo
echo "Then record it in cairo/address.md, in strk20.json at the repo root and in .env.local as"
echo "NEXT_PUBLIC_VEILCAST_MARKET_$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')=<contract_address>"
