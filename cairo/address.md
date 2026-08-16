# Classes and addresses

The market is bound to one pool and one token when it is constructed, and neither can be changed
afterwards. A market on a different pool is a different deployment.

## VeilcastMarket (`src/market.cairo`)

Not declared yet. Deploy with `scripts/deploy.sh <sepolia|mainnet>`, then record it here:

```
class hash                 :
contract address (sepolia) :
contract address (mainnet) :
```

Constructor calldata is `(pool, token)`:

```
pool  (mainnet) : 0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
token           : 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d   (STRK)
```

A deployed address also belongs in `strk20.json` at the repo root, which is what the sprint hub
reads, and in `.env.local` as `NEXT_PUBLIC_VEILCAST_MARKET_<NETWORK>` so the frontend can find it.
