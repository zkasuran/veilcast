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

## PragmaResolver (`src/pragma_resolver.cairo`)

Optional. Deployed, it can hold the resolver role for price markets and settle them from a Pragma
feed. Not declared yet.

```
class hash                 :
contract address (sepolia) :
contract address (mainnet) :
```

Constructor calldata is `(market, oracle, max_price_age)`. The oracle addresses are Pragma's own,
read live on 2026-08-16: `get_data_median(SpotEntry('STRK/USD'))` answered on mainnet with 12
publishers at 8 decimals, nine minutes old, then on Sepolia with 1 publisher and a median from
February, which is why the staleness window is a constructor argument rather than a constant.

```
oracle (mainnet) : 0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b
oracle (sepolia) : 0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a
max_price_age    : 3600 on mainnet. Sepolia needs a wide window or its stale feed settles nothing
```

The address goes in `.env.local` as `NEXT_PUBLIC_VEILCAST_RESOLVER_<NETWORK>`.
