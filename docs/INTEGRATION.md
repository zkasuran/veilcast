# Integration

Wire an agent, a bot or an app into Veilcast from zero. This document is the reference for the call
sequences and the exact calldata; `OPERATIONS.md` covers running one for real and `SECURITY.md`
covers the trust model.

Three surfaces exist and they all drive the same contracts:

| Surface | Use it when | Needs |
| --- | --- | --- |
| `agent/` (`veilcast-agent`) | an autonomous agent or a script, headless | Node 20, a funding account, a built privacy SDK for writes |
| `sdk/` (`veilcast-sdk`) | a TypeScript app with a browser wallet | starknet.js v10 |
| Raw JSON-RPC | any language | nothing |

---

## What is on-chain

Starknet mainnet (`SN_MAIN`). Every address below is live and readable right now.

| Contract | Address |
| --- | --- |
| STRK20 privacy pool | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |
| STRK token | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |
| VeilcastMarket | `0x036be78d67d6e94b79d3a8a7891b67871d4f17342d4c323be8f6ed469c36c6b8` |
| PragmaResolver | `0x0665a23caf88a7be47db35a7b6c4ecfae7de8d51405004d579f5553a680a259b` |
| CommitteeResolver | `0x00b0dec2742d5f7f62bdc4a7b93c5caabe17b6b9d49200d9c1c0eae8e64e6cd7` |
| LeveragedMarket | not deployed yet |

Verify any of this yourself rather than trusting the table:

```bash
node agent/cli.mjs verify --file strk20.json
```

It fetches every recorded receipt, asserts each one succeeded with a pool event and checks each
contract's deployed class hash against the record. It exits non-zero if a single claim fails.

---

## The headless mainnet path

This is the part worth reading carefully, because it is the part most integrations get wrong.

A STRK20 pool action carries a STARK proof. Producing that proof needs a proving service. The
mainnet proving service URL was never published in the program's docs, which is why most of the
field concluded that mainnet pool actions require a browser wallet with a prover baked in.

They do not. The proving and discovery services are reachable over OHTTP with no API key:

```
proving    https://cloud.argent-api.com/v1/privacy/proving
discovery  https://cloud.argent-api.com/v1/privacy/discovery
```

`GET {url}/ohttp-keys` on either returns an HPKE key config. That is the honest probe for
reachability: it is the same key material a real request uses, so a 200 means the service will talk
to you rather than merely that a hostname resolves.

### Seven rules that make it work

Each of these was learned by hitting the failure. Every one is encoded once, in
`agent/src/pool.mjs`, so you do not have to rediscover them.

1. **The viewing key must be canonical.** `poseidon([privateKey]) mod (n / 2)` and never zero,
   where `n` is the Stark curve order. Anything else fails with `PRIVATE_KEY_NOT_CANONICAL`. See
   `viewingKey` in `agent/src/keys.mjs`.
2. **Prove against an old enough block.** The sequencer rejects a proof whose base block is newer
   than about 10 blocks. Use `head - 15`.
3. **Submit is proof-carrying and single-call.**
   `account.execute([call], { proofFacts, proof })`. Wrapping it in a multicall breaks ProofFacts
   parsing and the pool rejects it.
4. **The allowance is a separate, earlier transaction.** The pool `transferFrom`s the deposit and
   its fee, so approve the pool for STRK in its own ordinary transaction first.
5. **A fresh account's first deposit is atomic register plus setup plus deposit.** Running setup
   alone gives `NO_REPLAY_PROTECTION`. Registering then auto-setting-up a dirty account gives
   `SUBCHANNEL_NOT_FOUND`. Use a fresh account and the atomic flow.
6. **Wait for the previous note to be indexed between deposits.** Otherwise the prover returns
   `INDEX_NOT_SEQUENTIAL`. Poll discovery; do not sleep and hope.
7. **Debugging is free.** The prover simulates server-side and rejects a bad invocation at
   `prove()` time with the real Cairo felt, before any gas is spent. This is why every money command
   in `veilcast-agent` is a dry run by default: the dry run genuinely validates.

### The privacy SDK is not on npm

`@starkware-libs/starknet-privacy-sdk` is not published. Build it once:

```bash
git clone https://github.com/starkware-libs/starknet-privacy
cd starknet-privacy/sdk && npm install && npm run build
export VEILCAST_PRIVACY_SDK=$PWD
```

Read-only commands work without it. Money commands need it and `veilcast-agent doctor` says so
plainly rather than failing obscurely.

---

## Environment

Every value has a working mainnet default, so nothing below is required to read.

| Variable | Meaning |
| --- | --- |
| `VEILCAST_RPC_URL` | Starknet RPC. Defaults to a keyless public endpoint. |
| `VEILCAST_POOL` | STRK20 pool address. |
| `VEILCAST_TOKEN` | Collateral token. STRK. |
| `VEILCAST_MARKET` | VeilcastMarket address. |
| `VEILCAST_LEVERAGE` | LeveragedMarket address. |
| `VEILCAST_PROVING_URL` | Proving service. |
| `VEILCAST_DISCOVERY_URL` | Discovery service. |
| `VEILCAST_PROVE_LAG` | Blocks behind head to prove at. Default 15, minimum 10. |
| `VEILCAST_HOME` | Where the agent keeps its key and state. Default `./.veilcast`. |
| `VEILCAST_PRIVACY_SDK` | A built privacy SDK. Required for writes. |
| `VEILCAST_ACCOUNTS` | An sncast accounts file that pays gas. |
| `VEILCAST_ACCOUNT` | Which account in that file to use. |

---

## Calldata layouts

The pool passes raw felts through to the contract, so these have to be exact. Each layout is
mirrored in four implementations (Cairo, the SDK, the app, the agent runtime) and pinned by a shared
test vector, so a drift fails a test rather than reverting a transaction.

### MarketAction

```
Bet    [0, market_id, outcome, amount, position_key]
Claim  [1, market_id, outcome, position_key, r, s, target_variant, target_data]
```

`target_variant` is `0` for a payout into an open note created in the same transaction (with
`target_data` the note id) or `1` for a payout to an address (with `target_data` the recipient).

### LeverageAction

```
Open        [0, market_id, side, position_key, margin, leverage_bps, max_price_bps,
             agent_key, stop_price_bps, take_price_bps, payout_target]
Close       [1, market_id, side, position_key, r, s, target_variant, target_data]
AgentClose  [2, market_id, side, position_key, r, s]
```

`side` is `0` for YES and `1` for NO. Long NO is the short-YES trade, so two sides cover both
directions. `leverage_bps` is basis points of 1x: `10000` is 1x and `50000` is the 5x cap.

The last four fields of `Open` are the mandate. All zero means self-managed and no agent can ever
close that position. `AgentClose` carries six felts and names neither a target nor a price: the
contract reads both from the stored mandate, which is precisely why an agent cannot redirect a
payout.

### Signatures

Both close paths sign the same Poseidon hash:

```
poseidon([CLOSE_MESSAGE_TAG, lev_address, market_id, side, position_key, target])
```

`CLOSE_MESSAGE_TAG` is the short string `VEILCAST_LEVCLOSE`. The pinned vector every layer asserts:

```
close_message_hash('LEV', 7, 1, 'COUPON', 0)
  = 0x1b63599a3692bd03b2fb7691332e685cffb4bb5217293a435bf23f2c4790e8e
```

The difference between an owner close and an agent close is only which key verifies it. The owner
path verifies against `position_key`; the agent path verifies against the mandate's `agent_key`. So
neither signature is valid on the other path and neither can be replayed as the other.

---

## Call sequences

### Read anything

No keys, no setup, free. The parimutuel verbs work against the deployed mainnet market today.

```bash
node agent/cli.mjs status
node agent/cli.mjs markets --stake 5      # the live board with odds quoted for a 5 STRK stake
node agent/cli.mjs flow --market 0        # that market's bets, from its own event log
node agent/cli.mjs lev-markets
node agent/cli.mjs quote --market 0 --side yes --margin 10 --leverage 3x
```

Two details in the board decoder that are easy to get wrong. A `MarketView` embeds a `ByteArray`, which
serializes as `[n_full_words, ...words, pending_word, pending_len]`, so the fields after the question do
not sit at fixed offsets and the felt stream has to be walked. And an event scan must start at the
deployment block rather than genesis: a public RPC answers an over-wide range with an empty page instead
of an error, so scanning from zero silently reports a market with no activity.

Or over raw RPC: `starknet_call` against `get_market`, `get_position`, `get_mandate`, `price_bps`,
`position_equity`, `get_vault_free`, `get_total_backing`, `get_insurance`.

### Shield STRK into the pool

```
1. approve(pool, amount)                    ordinary transaction, must land first
2. build({autoRegister, autoSetup, autoDiscover}).with(STRK).deposit({amount})
3. account.execute([call], {proofFacts, proof})
```

Drop `autoRegister` and `autoSetup` after the first deposit and wait for the prior note to index.

### Place a private bet

```
1. mint a fresh coupon keypair off-chain
2. withdraw({recipient: market, amount}).surplusTo(self).done()
     .invoke(() => ({contractAddress: market, calldata: betCalldata}))
3. proof-carrying submit
```

The market receives an amount, an outcome and a public key it has never seen. The on-chain sender is
the pool's relayer.

### Open a leveraged position with a mandate

```
1. mint a fresh coupon keypair off-chain
2. build the mandate: agent public key, stop and take bands, your own payout address
3. withdraw({recipient: leverage, amount: margin}).surplusTo(self).done()
     .invoke(() => ({contractAddress: leverage, calldata: openCalldata}))
4. proof-carrying submit
```

A mandate can only be set here, at open. There is no setter, so an authority can never be widened
after the fact.

### Fire a mandate as an agent

```
1. read get_mandate to learn the pinned target and the granted band
2. read price_bps and check the band is met, which is free
3. sign the close message over the PINNED target with the agent key
4. invoke AgentClose through the pool, with a note operation alongside it
```

Step 2 matters: firing outside the band reverts with `MANDATE_NOT_MET` and checking first costs
nothing.

### Liquidate

Ordinary public transaction, no proof and no privacy, because liquidation is infrastructure rather
than a trade.

```
liquidate(market_id, side, position_key)
```

Permissionless and only valid at or below 8% health.

---

## Errors and what to do about them

| Felt | Meaning | Fix |
| --- | --- | --- |
| `PRIVATE_KEY_NOT_CANONICAL` | viewing key out of range | reduce mod `n/2`, never zero |
| `INDEX_NOT_SEQUENTIAL` | a prior note is not indexed | poll discovery, then retry |
| `NO_REPLAY_PROTECTION` | invoke with no note operation | add a note transfer alongside it |
| `SUBCHANNEL_NOT_FOUND` | partially set-up account | use a fresh account with the atomic first deposit |
| `MANDATE_NOT_MET` | price is inside the band | wait; re-checking is free |
| `NO_MANDATE` | position is self-managed | only the owner can close it |
| `BAD_CLOSE_SIGNATURE` | wrong key or wrong target | agent signs over the pinned target with its agent key |
| `HEALTHY` | above the maintenance floor | not liquidatable yet |
| `SLIPPAGE` | book moved past the guard | re-quote, then raise `max_price_bps` if acceptable |
| `INSUFFICIENT_VAULT` | vault cannot lend that much | lower leverage or add liquidity |
| `MARGIN_NOT_FUNDED` | margin did not arrive | the withdraw must be in the same transaction as the open |
| `BAD_LEVERAGE` | outside 1x to 5x | pass 10000 to 50000 basis points |
| `POSITION_EXISTS` | key already used on that market and side | mint a fresh key per position |

`veilcast-agent` decodes these out of a revert automatically and attaches the fix to its JSON
output, so an agent can branch on `felt` and read `hint`.

---

## Wiring a host with no shell

Everything above assumes a process that can run a command. A browser host cannot, so the runtime also
speaks Model Context Protocol over stdio:

```bash
npx veilcast-agent mcp
```

Any host that reads an `mcpServers` map takes this config verbatim. `veilcast-agent init` writes it to
`mcp.json` plus `.mcp.json` for you:

```json
{
  "mcpServers": {
    "veilcast": {
      "command": "npx",
      "args": ["-y", "veilcast-agent", "mcp"],
      "env": { "VEILCAST_RPC_URL": "https://rpc.starknet.lava.build" }
    }
  }
}
```

Four properties are worth knowing before you build against it.

**The tool list is generated from the same catalog the shell skills are.** A browser host and a terminal
host cannot be told a different set of verbs, because there is one source and both render from it.

**`confirm` is never a required argument.** A dry run is the default on every tool that spends. The
schema says so in the field description rather than only in prose, so a model reads it before filling the
field in. A schema that demanded `confirm` would get it set to satisfy the schema.

**Four verbs are withheld rather than offered broken.** `init` writes to a local filesystem, `keeper` and
`watch` never return, then `lev-close` takes the owner's bearer coupon, which must not cross a tool
boundary into a hosted model's context. Calling one returns `-32602` with the reason in `data.withheld`,
because a menu with an item that cannot work is worse than a shorter menu.

**A refused tool is content with `isError`, not a protocol error.** The call itself succeeded, so the
model gets the envelope with its `error`, `felt` and `hint` fields and can recover. A transport error
would just be retried.

Two resources come with the tools. `veilcast://capabilities` is the machine-readable manifest, including
the trust boundary, so a model that has read it will not propose a plan the contract would refuse.
`veilcast://privacy` states what is and is not private, because overclaiming is the common mistake and
STRK20 gives identity privacy rather than amount privacy.

### Alerts without a daemon

A browser host cannot receive a webhook, so nothing can be pushed to it. `alerts` derives every condition
worth interrupting somebody over from the current block on each call, which means an alert cannot be
stale and cannot fire twice for something already resolved. A host polls it on a timer.

```
critical  the solvency invariant is broken; a firable stop is about to be liquidated instead
warning   something that costs money if ignored: a band met, an empty insurance fund
info      an opportunity: keeper work on the table, an LP slice not currently payable
```

Every alert carries a stable `id`, so a host that has already shown one recognises it on the next poll
rather than re-notifying, plus the exact command that acts on it. `sources` reports which inputs were
actually read, so `quiet: true` cannot be mistaken for a clean bill of health when the agent simply had
no key with which to check mandates.

---

## Output contract

Every `veilcast-agent` command prints exactly one JSON object on stdout and nothing else. Progress
and warnings go to stderr. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 2 | refused: a guard said no. Retry later, do not escalate. |
| 3 | not configured: run `doctor` and follow the fix |
| 4 | bad request |
| 5 | chain or service error |
| 70 | internal |

Code 2 is the one worth handling deliberately. It means the answer was no, not maybe: a band was not
met or a position was healthy. Re-check the chain later rather than retrying immediately.
