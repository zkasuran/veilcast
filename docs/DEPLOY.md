# Deploying Veilcast Contracts

This guide walks you from zero to a running Veilcast deployment on Sepolia or Mainnet. Budget 30
minutes for Sepolia and an hour for Mainnet (the extra time is the compliance screening on your
first pool interaction).

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Scarb](https://docs.swmansion.com/scarb/) | 2.20.0 | `curl -ssL https://docs.swmansion.com/scarb/install.sh \| sh` |
| [Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/) | 0.63.0 | `curl -L https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh \| sh` |
| A funded Starknet wallet | — | Ready or Braavos, switched to the target network |
| STRK for gas | — | ~0.5 STRK on Sepolia (free faucet), ~2 STRK on Mainnet |

Verify your toolchain:

```bash
scarb --version   # scarb 2.20.0
snforge --version # snforge 0.63.0
sncast --version  # sncast 0.63.0
```

---

## Quick start (CI)

If you have GitHub Actions secrets configured, the fastest path is the automated workflow:

```
Actions → Deploy contracts → Run workflow → pick "sepolia" or "mainnet"
```

Required secrets:
- `DEPLOYER_ADDRESS` — your funded account address
- `DEPLOYER_PRIVATE_KEY` — its private key
- `DEPLOYER_ACCOUNT_TYPE` — `oz`, `argent`, or `braavos`

For Sepolia you also need to pass the `pool_address` input (the STRK20 pool on Sepolia). For
Mainnet the pool address defaults to the verified one from the sprint docs.

The workflow declares, deploys, sets repo variables for the Pages build, and commits the addresses
back to the repo. One click, everything wired.

---

## Manual deployment

### Step 1 — Import your deployer account

```bash
sncast account import \
    --name veilcast \
    --address 0x<your_account_address> \
    --private-key 0x<your_private_key> \
    --type argent \
    --network sepolia
```

Replace `argent` with `oz` or `braavos` depending on your wallet type. Do the same for `mainnet`
if deploying there.

> **Never commit your private key.** The key lives in sncast's local keystore only.

### Step 2 — Run the tests

```bash
cd cairo
snforge test
```

All 35 tests must pass before you deploy. A failing test means the contract has a bug that will
cost real gas to discover on-chain.

### Step 3 — Build

```bash
scarb build
```

This produces Sierra and CASM artifacts under `target/dev/`.

### Step 4 — Declare class hashes

```bash
sncast --account veilcast declare --contract-name VeilcastMarket --network sepolia
sncast --account veilcast declare --contract-name PragmaResolver --network sepolia
sncast --account veilcast declare --contract-name CommitteeResolver --network sepolia
```

Each prints a class hash. If a class is already declared (same bytecode was deployed before), sncast
errors with "already declared" — that's fine, grab the hash from the error message.

Record the class hashes:

```
VeilcastMarket class hash     : 0x...
PragmaResolver class hash     : 0x...
CommitteeResolver class hash  : 0x...
```

### Step 5 — Deploy VeilcastMarket

The market takes two constructor arguments: `(pool, token)`.

```bash
# Sepolia — pass YOUR Sepolia pool address
sncast --account veilcast deploy --network sepolia \
    --class-hash <VeilcastMarket_class_hash> \
    --constructor-calldata <SEPOLIA_POOL_ADDRESS> \
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d

# Mainnet — the verified pool from the sprint docs
sncast --account veilcast deploy --network mainnet \
    --class-hash <VeilcastMarket_class_hash> \
    --constructor-calldata \
        0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a \
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
```

Save the deployed address. This is the address the app, the SDK, and every user interacts with.

### Step 6 — Deploy PragmaResolver (optional)

Constructor: `(market, oracle, max_price_age)`.

```bash
# Sepolia (wide staleness window — the Sepolia feed is rarely updated)
sncast --account veilcast deploy --network sepolia \
    --class-hash <PragmaResolver_class_hash> \
    --constructor-calldata <market_address> \
        0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a \
        31536000

# Mainnet (1-hour window — the mainnet feed updates every few minutes)
sncast --account veilcast deploy --network mainnet \
    --class-hash <PragmaResolver_class_hash> \
    --constructor-calldata <market_address> \
        0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b \
        3600
```

### Step 7 — Deploy CommitteeResolver (optional)

Constructor: `(market)`.

```bash
sncast --account veilcast deploy --network sepolia \
    --class-hash <CommitteeResolver_class_hash> \
    --constructor-calldata <market_address>
```

### Step 8 — Record addresses

Update three places:

#### `cairo/address.md`

Fill in the class hashes and contract addresses for the deployed network.

#### `strk20.json` (repo root)

```json
{
  "transactions": [],
  "contracts": ["<market_address>", "<resolver_address>", "<committee_address>"],
  "demo_video": "",
  "demo_url": "https://zkasuran.github.io/veilcast/"
}
```

#### `.env.local`

```bash
NEXT_PUBLIC_VEILCAST_MARKET_SEPOLIA=<market_address>
NEXT_PUBLIC_VEILCAST_RESOLVER_SEPOLIA=<resolver_address>
NEXT_PUBLIC_VEILCAST_COMMITTEE_SEPOLIA=<committee_address>
```

#### GitHub repository variables (for Pages CI)

```bash
gh variable set VEILCAST_MARKET_SEPOLIA --body "<market_address>"
gh variable set VEILCAST_RESOLVER_SEPOLIA --body "<resolver_address>"
gh variable set VEILCAST_COMMITTEE_SEPOLIA --body "<committee_address>"
```

---

## Verifying on explorers

After deployment, confirm your contracts on Voyager or Starkscan:

- **Sepolia:** `https://sepolia.voyager.online/contract/<address>`
- **Mainnet:** `https://voyager.online/contract/<address>`

Check that:
1. The contract exists and shows a valid class hash
2. The constructor arguments match what you passed
3. You can read the `pool()` and `token()` view functions

---

## Creating your first market

Once deployed, create a test market to verify the full flow:

```bash
# Using sncast (or through the app UI)
sncast --account veilcast invoke \
    --network sepolia \
    --contract-address <market_address> \
    --function open_market \
    --calldata \
        <question_felt> \       # short_string of the question
        <outcome_a_felt> \      # label for outcome A
        <outcome_b_felt> \      # label for outcome B
        <close_timestamp> \     # unix timestamp when betting ends
        <resolver_address> \    # your own address, or the PragmaResolver
        0 \                     # fee_bps (0 = no fee for testing)
        0x0                     # fee_recipient (zero when no fee)
```

Or just use the app: connect your wallet, click "Create Market", and fill in the form.

---

## Mainnet pool transactions (for the sprint)

After deploying to Mainnet, you need three pool transactions for `strk20.json`:

1. **Shield** — deposit STRK into the STRK20 pool (use the app or strk20.starknet.io/app)
2. **Bet** — place a bet on a market (this is a pool action through the relayer)
3. **Claim** — collect a payout from a resolved market (or make another bet)

Each of these emits a pool event. Record the transaction hashes in `strk20.json`:

```json
{
  "transactions": ["0x...", "0x...", "0x..."],
  "contracts": ["<market>", "<resolver>", "<committee>"],
  "demo_video": "",
  "demo_url": "https://zkasuran.github.io/veilcast/"
}
```

> **Important:** Private transactions are submitted by rotating relayers, not your wallet. The
> transaction sender will be a relayer address. The sprint verifies your transactions against the
> pool's own `Deposit` event, not the transaction sender.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `class already declared` | Not an error — use the class hash from the message |
| `insufficient balance` | Fund the deployer with more STRK for gas |
| `transaction reverted` | Check constructor calldata (pool address, token) |
| Deposit reverts at screening | Your address did not pass compliance — try a different account |
| App shows "not deployed" | Check `.env.local` values match the deployed addresses |
| Pages shows wrong address | Update the GitHub repo variable and re-run the Pages workflow |

---

## Network reference

| | Mainnet | Sepolia |
|---|---------|---------|
| Chain ID | `SN_MAIN` | `SN_SEPOLIA` |
| STRK20 Pool | `0x040337b...812a` | Ask in Telegram |
| STRK Token | `0x04718f5...938d` | Same |
| Pragma Oracle | `0x2a85bd...875b` | `0x036031d...131a` |
| RPC | `https://rpc.starknet.lava.build` | `https://api.cartridge.gg/x/starknet/sepolia` |
| Explorer | voyager.online | sepolia.voyager.online |

---

## Using the deploy script directly

The `cairo/scripts/deploy.sh` script wraps all the steps above:

```bash
# Sepolia (you must set VEILCAST_POOL)
VEILCAST_POOL=0x<sepolia_pool> ./scripts/deploy.sh sepolia

# Mainnet (pool has a default)
./scripts/deploy.sh mainnet
```

It runs tests, builds, declares, then prints the exact deploy commands with the right calldata
for you to copy-paste. It does not deploy automatically because deploying twice creates a second
empty market.
