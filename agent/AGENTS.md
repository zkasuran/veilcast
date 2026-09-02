# Veilcast for agents

Trade and manage positions on Veilcast, a private prediction market on Starknet's STRK20 privacy pool, headlessly. Identity is private, amounts are public. An agent can hold a bounded mandate to close a position on an owner's behalf without ever being able to redirect the money.

Network: mainnet. Every command prints one JSON object on stdout; progress goes to stderr.

## Start here

```bash
veilcast-agent status     # what you are pointed at and what you may do
veilcast-agent doctor     # if anything looks wrong, this names the fix
```

## The money-safety protocol, every time

Every money command is a dry run unless --confirm is passed. A dry run still proves the action server-side, so it validates for free and reports the real Cairo error.

1. Run the command without --confirm.
2. Read the JSON and check the plan is what you intended.
3. Re-run the identical command with --confirm only if it is.

## What you can and cannot do

You can:
- read every market, price, position, mandate and the vault's solvency
- quote an entry or mark a position for free, with maths that matches the contract exactly
- close a position it holds a mandate for, once the live price is inside the granted band
- liquidate any position that has fallen to the 8% maintenance floor, earning the 1% keeper reward

You cannot do the following. The contract enforces it rather than convention:
- redirect a payout: an agent close pays the address pinned at open, read from storage, never from the agent's input
- act outside its band: the contract compares the live marginal price to the stop and take
- widen its own mandate: a mandate is write-once at open and has no setter
- close a self-managed position: a zeroed agent key means no agent may ever act
- impersonate the owner: an owner signature and an agent signature verify against different keys, so neither can be replayed as the other

A stolen agent key gets an attacker nothing but the ability to do what the owner already asked for, at a price the market actually reached, paying the owner's own address.

## Never do these

- Never generate, request, store or accept an owner's position private key. The runtime refuses anything that looks like one.
- Never pass a private key as a command argument. Coupons are read from files.
- Never retry a command that failed with exit code 2 without re-checking the chain first: the answer was no, not maybe.
- Never substitute your own address for a mandate's payout target. The contract ignores it anyway.

## Privacy, stated accurately

Private: who opened or closed a position: the contract is never told an address and the on-chain sender is the pool's relayer; the link between two positions by one person: every position is keyed by a fresh bearer coupon.

Public: every amount: margins, notionals, volumes and prices are all on-chain and readable; liquidity provision and liquidation, which are infrastructure rather than trades.

Never describe amounts as private. STRK20 gives identity privacy, not amount privacy and overclaiming it is wrong.

## Commands

- `veilcast-agent status`
  Endpoints, contracts, vault solvency and exactly what this agent can do. Run this first.
- `veilcast-agent doctor`
  Diagnose the setup and name the fix for anything broken.
- `veilcast-agent agent-key`
  Print this agent's public key, which an owner names in a mandate. Safe to share.
- `veilcast-agent markets --stake <STRK> to quote the odds for a specific size`
  The live parimutuel board: questions, outcome volumes, implied probabilities and what a stake would pay. Works today with no deployment and no keys.
- `veilcast-agent flow --market <id>`
  One market's bet history from its event log: amounts and bearer keys, never addresses.
- `veilcast-agent lev-markets`
  The leveraged board with live YES and NO prices.
- `veilcast-agent vault`
  Vault free collateral, backing, insurance and the solvency invariant.
- `veilcast-agent position --market <id> --side <yes|no> --key <positionPublicKey>`
  One position marked to the live book: equity, P&L, health.
- `veilcast-agent mandate --market <id> --side <yes|no> --key <positionPublicKey>`
  The authority a position carries, read from chain.
- `veilcast-agent quote --market <id> --side <yes|no> --margin <STRK> --leverage <3x|30000>`
  What an open would do, computed exactly as the contract does. Always quote first.
- `veilcast-agent keeper-scan --min-reward <STRK>`
  Positions liquidatable now, best paying first.
- `veilcast-agent mandate-scan`
  Mandates this agent holds and which are firable right now.
- `veilcast-agent verify --file <path>`
  Re-derive every claim in strk20.json straight from chain.
- `veilcast-agent shield --amount <STRK> --first for a fresh account --confirm to actually send` (spends, dry run by default)
  Move STRK into the privacy pool.
- `veilcast-agent lev-open --market <id> --side <yes|no> --margin <STRK> --leverage <3x> --agent-key <K> --stop <bps> --take <bps> --payout <addr> to grant a mandate --confirm to actually send` (spends, dry run by default)
  Open a leveraged position, optionally granting a mandate.
- `veilcast-agent lev-close --market <id> --side <yes|no> --coupon <file> --to <address> --confirm to actually send` (spends, dry run by default)
  Close a position on the owner's terms. Needs the coupon file.
- `veilcast-agent agent-close --market <id> --side <yes|no> --key <positionPublicKey> --confirm to actually send` (spends, dry run by default)
  Fire a mandate granted to this agent.
- `veilcast-agent liquidate --market <id> --side <yes|no> --key <positionPublicKey> --confirm to actually send` (spends, dry run by default)
  Liquidate a position at the maintenance floor and earn the keeper reward.
- `veilcast-agent keeper --min-reward <STRK> --interval <sec> --once --confirm to actually send` (spends, dry run by default)
  Scan and liquidate continuously.
- `veilcast-agent watch --interval <sec> --once --confirm to actually send` (spends, dry run by default)
  Scan and fire mandates when a band is met.

## Exit codes

- `0`: ok
- `2`: refused: a guard said no (band not met, position healthy). Retry later, do not escalate.
- `3`: not configured: something is missing. Run doctor and follow the fix.
- `4`: bad request: fix the arguments.
- `5`: chain or service error.
- `70`: internal error.

## A worked example: run a keeper

```bash
# 1. See what is liquidatable. Free, no keys needed.
veilcast-agent keeper-scan --min-reward 0.01

# 2. Dry run one liquidation and read the plan.
veilcast-agent liquidate --market 0 --side yes --key 0x<positionPublicKey>

# 3. Send it.
veilcast-agent liquidate --market 0 --side yes --key 0x<positionPublicKey> \
  --accounts ./accounts.json --account keeper --confirm
```

## A worked example: hold and fire a mandate

```bash
# 1. Give the owner your public key. Safe to share: on its own it cannot move money.
veilcast-agent agent-key

# 2. The owner opens a position naming you, with a band and their own payout address.
#    You cannot do this step and you should not ask for the owner's coupon.

# 3. Watch for the band. Free.
veilcast-agent mandate-scan

# 4. Fire it when it is met. The payout goes to the owner's pinned address, not yours.
veilcast-agent agent-close --market 0 --side yes --key 0x<positionPublicKey> \
  --accounts ./accounts.json --account agent --confirm
```

Full manuals: `docs/INTEGRATION.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`.
