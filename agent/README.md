# veilcast-agent

### Delegate execution. Never custody.

> Drive [Veilcast](https://github.com/zkasuran/veilcast), a private and leveraged prediction market on
> Starknet's STRK20 privacy pool, from an autonomous agent. No browser, no wallet extension, no human in
> the loop. You can be given the power to close someone's position without ever being given the power to
> take their money.

```bash
npx veilcast-agent markets        # the live mainnet board, with odds and payout multiples
npx veilcast-agent init           # detect your host, write its skills, generate a key, probe mainnet
```

The first command needs nothing: no keys, no wallet, no configuration. It reads the deployed mainnet
market and prints one JSON object.

---

## Why this exists

A STRK20 pool action carries a STARK proof. Producing one needs a proving service. The mainnet
proving service URL was never published, so the field settled on a browser wallet with the prover baked
in, which means a human clicking. The proving and discovery services are reachable over OHTTP with no
API key, so a process can prove and submit on its own.

This package encodes that flow, plus every rule it took a failure to learn: the canonical viewing key,
proving against an old enough block, the proof-carrying single-call submit, the separate allowance
transaction, the atomic first deposit and the note indexing wait. Each one lives once, in `src/pool.mjs`.

---

## The safety model

**Every command that can spend is a dry run unless you pass `--confirm`.** A dry run still proves the
action server-side, so it validates the whole thing for free and reports the real Cairo error if it
would fail.

The protocol, every time:

1. Run the command without `--confirm`.
2. Read the JSON. Check the amounts, the market, the side and the payout target.
3. Re-run the identical command with `--confirm` only then.

Exit codes are stable, so an agent can branch on the number rather than parsing text:

| Code | Meaning |
|---|---|
| 0 | ok |
| 2 | refused: a guard said no. The answer was no, not maybe. Re-check later; scanning is free |
| 3 | not configured: run `doctor` and follow the fix |
| 4 | bad request |
| 5 | chain or service error |
| 70 | internal |

---

## Delegation without custody

The reason an agent can be trusted with a position is that it structurally cannot steal from one.

A **mandate** is a bounded authority the position owner attaches when opening: an agent key, a stop and
take price band, plus a payout address. All three are written to contract storage and checked on every
agent close. So an agent can fire a stop while the owner sleeps. It cannot:

- redirect the payout, because the contract reads the target from storage and the agent's calldata has
  nowhere to put a recipient
- act outside the granted band
- widen its own authority, since a mandate is write-once with no setter
- touch a self-managed position
- pass its signature off as the owner's, because the two verify against different keys

The worst a stolen agent key buys is doing what the owner already asked for, at a price the market
actually reached, paying the owner's own address. That is enforced in
[`cairo/src/leveraged_market.cairo`](https://github.com/zkasuran/veilcast/blob/main/cairo/src/leveraged_market.cairo)
and fuzzed, not promised in a prompt.

**An agent must never hold an owner's position private key.** It signs with its own agent key. The
runtime refuses a key whose public half owns a live position, then reads coupons from files rather than
arguments so a secret never lands in shell history.

---

## Install

```bash
npx veilcast-agent init
```

That detects the host (Claude Code, openclaw, Hermes or a host-neutral fallback), writes the right skill
files, generates the agent key at mode 0600, probes mainnet and prints a capability report. It refuses
to claim readiness it does not have.

Then `npx veilcast-agent doctor` diagnoses anything broken and names the exact fix.

Read-only commands work immediately. For writes you need two more things:

```bash
export VEILCAST_PRIVACY_SDK=/path/to/built/starknet-privacy/sdk
export VEILCAST_ACCOUNTS=/path/to/accounts.json
export VEILCAST_ACCOUNT=keeper
```

`@starkware-libs/starknet-privacy-sdk` is not published to npm, so it has to be built once from
[starkware-libs/starknet-privacy](https://github.com/starkware-libs/starknet-privacy). `doctor` says so
plainly rather than failing obscurely. The accounts file is an sncast accounts file; the runtime reads
the one named account and never writes to it, so the operator keeps custody of the funding key.

---

## Drive it from a web coding host

A browser host (claude.ai, an IDE panel, a hosted agent) has no shell, so a skill file telling it to type
`veilcast-agent vault` is useless there. The runtime speaks **MCP** for exactly that case, over stdio:

```bash
npx veilcast-agent mcp
```

`init` writes the config for you. Any host that reads an `mcpServers` map takes this verbatim:

```json
{
  "mcpServers": {
    "veilcast": { "command": "npx", "args": ["-y", "veilcast-agent", "mcp"] }
  }
}
```

Twenty tools, generated from the same catalog the shell skills are generated from, so a browser host and
a terminal host can never be told a different set of verbs. Two resources come with it:
`veilcast://capabilities` is the machine-readable manifest including the trust boundary, and
`veilcast://privacy` states what is private before a model describes the system to a user.

**Nothing spends without `confirm: true`**, exactly as the CLI behaves. The schema says so in the field
description, so a model reads it before filling it in. Four verbs are withheld rather than offered
broken: `init` needs a local filesystem, `keeper` and `watch` run forever, then `lev-close` takes the
owner's bearer coupon, which must never cross a tool boundary into a hosted model's context. Asking for
one returns the reason.

### Alerts, without a daemon

A browser host cannot receive a webhook, so there is nothing to push into. `alerts` derives everything
worth interrupting somebody over from the current block on every call, which means an alert can never be
stale or fire twice for a condition that has since resolved:

```bash
veilcast-agent alerts --lp 0x<yourAddress>
```

It ranks by what it costs to ignore. `critical` is money at risk now: the solvency invariant broken, or
a firable stop about to be liquidated instead, which charges the owner a penalty a stop would avoid.
`warning` is something that will cost money if left. `info` is an opportunity, such as keeper work on the
table. Each alert carries the command that acts on it. `sources` reports which inputs were actually
read, so a quiet result cannot be mistaken for a complete one.

---

## Commands

Read-only, free, no keys:

| Command | What it does |
|---|---|
| `status` | endpoints, contracts, vault solvency and exactly what this agent can do |
| `doctor` | diagnose the setup and name the fix for anything broken |
| `markets [--stake STRK]` | the live parimutuel board: questions, volumes, probabilities, payouts |
| `flow --market <id>` | that market's bets from its event log: amounts and bearer keys, no addresses |
| `lev-markets` | the leveraged board with live YES and NO prices |
| `vault` | vault free collateral, backing, insurance, LP share price and the solvency invariant |
| `vault-lp --lp ADDR` | one LP's shares, what a share is worth, what burning the holding would pay, whether the vault can pay it now, plus P&L from their own log |
| `position --market --side --key` | one position marked to the live book: equity, P&L, health |
| `mandate --market --side --key` | the authority a position carries, read from chain |
| `quote --market --side --margin --leverage` | what an open would do, exactly as the contract computes it |
| `keeper-scan [--min-reward STRK]` | positions liquidatable now, best paying first |
| `mandate-scan` | mandates this agent holds and which are firable |
| `agent-key` | this agent's public key, for an owner to name in a mandate |
| `alerts [--lp ADDR]` | everything needing attention now, most severe first, derived from the current block |
| `verify [--file strk20.json]` | re-derive every recorded claim straight from chain, then score each transaction under the program's rule |
| `mcp` | serve MCP on stdio, for a web coding host with no shell |

Money, dry run by default:

| Command | What it does |
|---|---|
| `shield --amount STRK [--first]` | move STRK into the privacy pool |
| `bet --market --outcome --amount` | place a private bet |
| `lev-open --market --side --margin --leverage` | open a leveraged position, optionally granting a mandate |
| `lev-close --market --side --coupon FILE --to ADDR` | close on the owner's own terms |
| `agent-close --market --side --key` | fire a mandate granted to this agent |
| `liquidate --market --side --key` | liquidate at the maintenance floor, earning the keeper reward |
| `keeper [--min-reward] [--interval]` | scan and liquidate continuously |
| `watch [--interval]` | scan and fire mandates when a band is met |

---

## Worked example: run a keeper

```bash
# Free, no keys. Enumerates open positions from the event log and marks each one.
veilcast-agent keeper-scan --min-reward 0.5

# Dry run one liquidation and read the plan.
veilcast-agent liquidate --market 0 --side yes --key 0x<positionPublicKey>

# Send it.
veilcast-agent liquidate --market 0 --side yes --key 0x<positionPublicKey> \
  --accounts ./accounts.json --account keeper --confirm
```

A keeper only earns if the reward clears its gas. The reward is 1% of notional capped by the surplus the
sale produced, so `--min-reward` is what separates a keeper that earns from one that donates.

## Worked example: hold and fire a mandate

```bash
# Give the owner your public key. Safe to share: on its own it cannot move money.
veilcast-agent agent-key

# The owner opens a position naming you, with a band and their own payout address.
# You cannot do this step, nor should you ask for their coupon.

# Watch for the band. Free, so poll as often as you like.
veilcast-agent mandate-scan

# Fire it when it is met. The payout goes to the address they pinned, not to you.
veilcast-agent agent-close --market 0 --side yes --key 0x<positionPublicKey> \
  --accounts ./accounts.json --account agent --confirm
```

---

## Privacy, stated accurately

STRK20 gives **identity privacy, not amount privacy.** Never describe amounts as private.

**Private:** who opened or closed a position, because the contract is never told an address and the
on-chain sender is the pool's relayer. The link between two positions by one person, because every
position is keyed by a fresh bearer coupon.

**Public:** every amount. Margins, notionals, volumes, prices, the vault's state. Liquidity provision
and liquidation, which are infrastructure rather than trades.

Amounts are public on purpose: a prediction market with hidden sizes cannot produce accurate odds.

---

## Programmatic use

```js
import { resolveConfig, board, quotePayout, scanKeeper } from "veilcast-agent";

const config = resolveConfig();
const { markets } = await board(config);
const best = markets[0].outcomes.map((o) => quotePayout(markets[0], o.outcome, 10n ** 18n));

const scan = await scanKeeper(config, { minRewardWei: 10n ** 17n });
console.log(scan.liquidatable, "positions liquidatable now");
```

Everything the CLI does is reachable from the API, because the CLI is a thin wrapper over it.

---

## Documentation

- [INTEGRATION.md](https://github.com/zkasuran/veilcast/blob/main/docs/INTEGRATION.md) wire an agent in
  from zero: every endpoint, every calldata layout, every call sequence
- [OPERATIONS.md](https://github.com/zkasuran/veilcast/blob/main/docs/OPERATIONS.md) run a keeper for
  real: measured costs, what to monitor, how to recover
- [SECURITY.md](https://github.com/zkasuran/veilcast/blob/main/docs/SECURITY.md) the threat model, where
  each guarantee is enforced and how it is proven

## License

MIT
