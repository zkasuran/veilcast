# Operations

Running a Veilcast agent for real: what it costs, what to watch and how to recover when something
fails. Costs here were measured on mainnet, not estimated.

---

## Install

```bash
npx veilcast-agent init
```

That generates the agent's signing key at mode 0600, writes the skill files for whichever host it
detects (Claude Code, openclaw, Hermes or a host-neutral `AGENTS.md`), probes mainnet and prints a
capability report. It refuses to claim readiness it does not have.

Then:

```bash
veilcast-agent doctor
```

`doctor` checks the RPC, the proving service, the discovery service, the agent key and its file
permissions, the privacy SDK path and the leveraged market deployment. It reports `healthy: false`
with a specific fix for each failure and exits 3. Fix the failures in the order it lists them.

For writes you need two more things:

```bash
export VEILCAST_PRIVACY_SDK=/path/to/built/starknet-privacy/sdk
export VEILCAST_ACCOUNTS=/path/to/accounts.json
export VEILCAST_ACCOUNT=keeper
```

The accounts file is an sncast accounts file. The runtime reads the one named account and never
writes to it, so the operator keeps custody of the funding key. The agent's own key is separate and
is not a funding key: see `SECURITY.md`.

---

## What operations cost

Measured on Starknet mainnet in August 2026. Gas prices move, so treat these as the shape of the
cost rather than a quote.

| Operation | Cost | Note |
| --- | --- | --- |
| Account deploy | ~0.08 STRK | one-time per account |
| Pool register plus setup plus first deposit | ~43 STRK | one-time per account, unavoidable, atomic |
| Later deposit | ~0.04 STRK | cheap once the account is set up |
| Private bet through the pool | ~3.1 to 3.7 STRK | the pool verifies a STARK proof on-chain |
| Leveraged open through the pool | same order | same proof path |
| Liquidation | ordinary transaction gas | no proof, so far cheaper |
| Declaring a contract class | ~8 STRK small, 35 to 60 STRK large | the real budget driver on deploys |

Two things follow from this. First, the one-time pool setup dominates a new account's cost, so funding
one account well beats spreading across several.

Second, the one that catches people: **a declare's gas amount is deterministic, but the
reserve you must hold is not the cost you will pay.** Measured on `LeveragedMarket` on 2026-09-02, the
declare consumes 1,777,666,080 l2 gas, identical across three consecutive estimator runs, so the amount
is a property of the class rather than an estimator artifact. At that day's l2 price that is 60.25 STRK
of unavoidable gas. `estimateDeclareFee` then pads the *price* by about 1.5x and asks for a 90 STRK
reserve. A transaction whose account cannot reserve the full bound is rejected before it executes,
even when the realized cost would have been lower.

So budget against the estimate rather than a projection. `VeilcastMarket` estimated 71.9 STRK and
settled at about 35, but that was the l2 price falling roughly by half between estimate and inclusion.
That is a market move, not a discount you can plan for.

### The deploy refuses to start underfunded

`cairo/scripts/deploy-leverage-mainnet.sh` runs a preflight before it spends anything: it reads the
deployer's balance, asks the node for a live declare estimate, adds the deploy, the vault seed, the
market liquidity and headroom for one real leveraged open, then exits non-zero if the balance does not
cover the total.

This exists because a half-finished deploy is the expensive failure. The declare is the single largest
cost and it is non-refundable, so running out afterwards leaves a paid-for class on-chain with nothing
deployed against it. The preflight budgets against the padded estimate rather than the projected
realized cost, which is deliberately pessimistic: unused balance is not spent, but an underfunded run
is money gone.

### After the deploy, one command finishes the job

`cairo/scripts/post-deploy.sh 0x<leverageAddress>` takes the address the deploy printed and completes
the submission without sending a single transaction: it checks the class deployed at that address is
the one in the working tree and refuses to record a claim it cannot back, writes the contract into
`strk20.json`, re-derives every claim in that file from chain, sets the GitHub variable the Pages build
reads so the Leverage tab stops saying "not deployed", then reports which agent verbs went live.

Each step was rehearsed against a devnet deployment before it was trusted with a real one, including
the class-hash mismatch refusal.

### Rehearse before you spend

`cairo/scripts/rehearse-devnet.mjs` runs the entire mainnet deploy against a local devnet first:
declare, deploy, seed the vault, create a market, open a leveraged position carrying a mandate, read
the position and the mandate back, prove a stranger key cannot fire it, prove the real agent cannot
fire it early, push the price through the band, fire the take, then assert the payout went to the
pinned address and the contract is still solvent.

```bash
starknet-devnet --seed 0 --port 5055 &
cd cairo && node scripts/rehearse-devnet.mjs
```

It exits non-zero on any failure. It also asserts the off-chain quote matches the chain felt for felt
rather than merely looking plausible. Every step the mainnet script will take has therefore already
run against a real Starknet node before a single real token is spent. Devnet gas is not mainnet gas,
so read the rehearsal for correctness rather than for cost.

**A keeper only earns if the reward clears its gas.** The reward is 1% of notional capped by the
surplus the sale produced, so a deeply underwater position can pay less than the headline rate.
`--min-reward` exists for exactly this:

```bash
veilcast-agent keeper --min-reward 0.5 --interval 60 --confirm
```

Without it, a keeper will happily spend more than it makes.

---

## Running a keeper

The keeper is what makes the leverage engine actually safe rather than theoretically safe. A vault
loan is only recoverable while the position still has value, so somebody has to be watching. The
reward is what pays for that somebody.

Start read-only, always:

```bash
veilcast-agent keeper-scan --min-reward 0.5
```

Free, no keys. It enumerates every open position from the `PositionOpened` event log, marks each one
against the live book and lists what is liquidatable, best paying first.

When the numbers look right:

```bash
veilcast-agent keeper --min-reward 0.5 --interval 60 --confirm
```

Without `--confirm` the loop scans and reports but sends nothing, which is a useful way to watch for
an hour before committing.

**Expect to lose races.** Liquidation is permissionless, so another keeper may take a candidate
between your scan and your submit. The loop treats a failed liquidation as normal competition and
carries on rather than stopping. If you are losing most races, lower `--interval` or run closer to a
sequencer.

---

## Running a mandate watcher

This is the agentic feature in its finished form: the owner is offline, the agent watches and when
the market reaches the price the owner named the agent closes and the money goes to the owner's own
pinned address.

```bash
veilcast-agent agent-key            # give this public key to the position owner
veilcast-agent mandate-scan         # free, shows what you hold and what is firable
veilcast-agent watch --interval 60 --confirm
```

`mandate-scan` reports mandates held by other agents separately as a count. Those carry no action for
you: the contract verifies against the stored agent key, so attempting one wastes gas to be told
`BAD_CLOSE_SIGNATURE`.

**A firable stop is time-sensitive.** If a position is at or below the maintenance floor, a keeper
will liquidate it and a liquidation charges the owner a penalty that a stop does not. `mandate-scan`
flags this as `alsoLiquidatable` on each row. Prioritise those.

---

## What to monitor

Four numbers, all free to read.

```bash
veilcast-agent vault      # free, backing, insurance and the solvency invariant
veilcast-agent status     # endpoint reachability and chain head
```

| Signal | Healthy | What it means if not |
| --- | --- | --- |
| `vault.solvent` | `true` | the contract holds at least what it owes. If false, stop trading and report it. |
| `vault.insurance` | growing | the fund that absorbs bad debt. Shrinking means liquidations are arriving late. |
| `vault.free` | non-zero | the vault can still lend. Zero means no new leveraged opens. |
| `probes.*.ok` | `true` | the proving and discovery services answer. If not, writes will fail. |

`solvent` is the invariant the Cairo suite fuzzes across random open, close and liquidate sequences.
Seeing it false on mainnet would mean something the tests do not model, which is worth a full stop.

---

## Failure modes and recovery

**A money command returns exit 2.** The answer was no. A band was not met or a position was healthy.
Nothing was sent and nothing was spent. Re-check later; scanning is free. Do not retry in a tight
loop and never try to work around the refusal.

**A money command returns exit 3.** Something is missing. Run `doctor` and follow the fix. Nothing
was sent.

**A dry run reports a Cairo felt.** Good: that is the point. The prover simulated server-side and
told you exactly why the action would fail before you spent gas. The `hint` field carries the fix.

**A deposit fails with `INDEX_NOT_SEQUENTIAL`.** The previous note is not indexed yet. The runtime
polls discovery for you, but under load you may need to wait longer. Retry the same command.

**A first deposit fails with `NO_REPLAY_PROTECTION` or `SUBCHANNEL_NOT_FOUND`.** The account's pool
state is half set up. This is not recoverable in place: use a fresh account with the atomic first
deposit. It is the one failure worth avoiding by construction rather than handling.

**A transaction is accepted but reverted.** Read `execution_status` on the receipt, not just
finality. `veilcast-agent verify` does this correctly; a naive check on `finality_status` alone will
call a reverted transaction a success.

**The agent key is lost.** Every live mandate naming it becomes unfireable, so those positions can
only be closed by their owners. That is the correct failure: no money is at risk, only the
delegation. Generate a new key with `init --rotate` and ask owners to name it on their next open.

**The agent key is stolen.** See `SECURITY.md`. The short version: an attacker can fire stops the
owner already asked for, at prices the market actually reached, paying the owner's own address. Rotate
the key and tell affected owners, but no funds are at risk.

---

## Known limitation: close and payout on mainnet V2

Deposits and bets prove and submit cleanly on mainnet. The **claim and payout path** does not, and
this is worth stating plainly rather than burying.

- An open-note claim reverts with `Invalid proof facts: expected PROOF0 got PROOF1`. The privacy SDK
  at `0.14.3-rc.5` emits a proof version the mainnet pool rejects on that path.
- An invoke-only claim to an address reverts with `NO_REPLAY_PROTECTION`, because the pool requires a
  note operation alongside an invoke.

So on mainnet today an agent can shield, bet and open leveraged positions headlessly and the payout
leg is blocked by an SDK version mismatch rather than by anything in Veilcast. The full lifecycle runs
end to end on Sepolia. This affects every team on the program rather than just us. It is tracked
upstream. When the SDK's proof version is updated the same code path will work with no change here.

Liquidation is unaffected, because it is an ordinary transaction with no pool proof.

---

## Hardening a long-running deployment

- **Run it where the RPC is.** Proving is a round trip per action and a distant node turns a keeper
  into a loser of races.
- **Use your own RPC endpoint.** The keyless public default is fine for reading and thin for a loop.
- **Keep the funding account thin.** It only needs gas plus the margin it will post. A keeper does not
  need a large balance and a large balance is a larger target.
- **Watch `insurance`, not just your own P&L.** A shrinking insurance fund is the early signal that
  liquidations across the whole market are arriving too late.
- **Log the JSON.** Every command emits one object with a stable shape. Keeping them is a complete
  audit trail of what the agent did and why.
