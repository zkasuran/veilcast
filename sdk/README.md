# veilcast-sdk

> Read and drive [Veilcast](https://github.com/zkasuran/veilcast), the private prediction market on
> Starknet's STRK20 pool, from any TypeScript app or bot.

<p>
  <img src="https://img.shields.io/badge/starknet.js-v10-blue?style=flat-square" alt="starknet.js v10" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/tests-11%20passing-brightgreen?style=flat-square" alt="Tests" />
</p>

The design in one line: **amounts and odds are public** so the price signal is honest, and **who
bet is not**. This SDK never asks for a wallet address for a bet. It builds the STRK20 action lists
the privacy pool runs on your behalf, so the on-chain sender is the pool's relayer.

---

## Install

```bash
npm install veilcast-sdk starknet
```

`starknet` (v10) is a peer dependency. The SDK ships the contract ABIs, so you need nothing else.

---

## API overview

The SDK exports three kinds of function:

| Layer | Purpose | Example |
|-------|---------|---------|
| **Reads** | Fetch and decode on-chain state | `loadBoard()`, `loadLevBoard()`, `oddsSeries()` |
| **Actions** | Build STRK20 action lists for private operations | `betActions()`, `openActions()`, `closeToWalletActions()` |
| **Calls** | Build `Call` objects for public admin operations | `createMarketCall()`, `resolveCall()`, `addLiquidityCall()` |

The leveraged market shares these three layers. `quoteOpen` and `markPosition` mirror the FPMM in
`pricing.cairo` so a quote matches the contract felt for felt, `openActions` and
`closeToWalletActions` build the private open and close, while the vault and admin calls
(`addLiquidityCall`, `createLevMarketCall`, `liquidateCall`) round it out.

---

## Quick start

### Read the board (no wallet needed)

```ts
import { RpcProvider } from "starknet";
import { loadBoard, formatStrk, impliedProbability } from "veilcast-sdk";

const provider = new RpcProvider({ nodeUrl: "https://rpc.starknet.lava.build" });
const MARKET = "0x..."; // your deployed VeilcastMarket address

const board = await loadBoard(provider, MARKET);
for (const m of board) {
    console.log(`#${m.id} ${m.question} (${m.state})`);
    console.log(`  Pot: ${formatStrk(m.pot)} STRK`);
    m.labels.forEach((label, i) => {
        const prob = impliedProbability(m.volumes[i], m.pot, m.labels.length);
        console.log(`  ${label}: ${formatStrk(m.volumes[i])} STRK (${(prob * 100).toFixed(1)}%)`);
    });
}
```

### Place a private bet

```ts
import { newCoupon, betActions, STRK_TOKEN, STRK_UNIT } from "veilcast-sdk";

// 1. Generate a fresh coupon — this IS the position
const coupon = newCoupon(marketId, /* outcome */ 0, 5n * STRK_UNIT);

// 2. SAVE THE COUPON before sending anything
// (losing it = losing the payout, there is no recovery)
saveToDisk(coupon);

// 3. Build the pool action list
const actions = betActions(STRK_TOKEN, MARKET, coupon);

// 4. Submit through the wallet — the pool's relayer sends it, your address is nowhere
const { transaction_hash } = await walletAccount.strk20InvokeTransaction(actions);
console.log("Bet placed:", transaction_hash);
```

### Collect winnings into a private note

```ts
import { claimIntoNoteActions, STRK_TOKEN } from "veilcast-sdk";

// One coupon, one payout into a fresh private note
const actions = claimIntoNoteActions(STRK_TOKEN, MARKET, coupon, myAddress);
await walletAccount.strk20InvokeTransaction(actions);
```

### Batch collect multiple positions

```ts
import { batchClaimIntoNotesActions, STRK_TOKEN } from "veilcast-sdk";

// All winning coupons in one transaction, each into its own note
const actions = batchClaimIntoNotesActions(STRK_TOKEN, MARKET, winningCoupons, myAddress);
await walletAccount.strk20InvokeTransaction(actions);
```

### Collect to a public address (trades privacy for convenience)

```ts
import { claimToWalletActions } from "veilcast-sdk";

const actions = claimToWalletActions(MARKET, coupon, recipientAddress);
await walletAccount.strk20InvokeTransaction(actions);
```

---

## Market reads

```ts
import { loadBoard, loadMarket, loadStake, quotePayout, settledPayout, positionStatus } from "veilcast-sdk";

// Latest 24 markets, newest first
const board = await loadBoard(provider, MARKET);

// One market by id
const market = await loadMarket(provider, MARKET, 7);

// Check a coupon's on-chain stake
const stake = await loadStake(provider, MARKET, coupon.marketId, coupon.outcome, coupon.positionKey);

// What this stake would pay if the outcome wins (live quote)
const payout = quotePayout(market, coupon.outcome, stake);

// What this stake pays now that the market settled
const settled = settledPayout(market, coupon.outcome, stake);

// Position lifecycle
const status = positionStatus(market, coupon.outcome, stake, false);
// → "live" | "closed" | "won" | "lost" | "refundable" | "collected" | "empty"
```

---

## Odds and history

```ts
import { loadMarketEvents, oddsSeries, impliedProbability, payoutMultiple } from "veilcast-sdk";

// Every event on one market, oldest first (no indexer needed)
const events = await loadMarketEvents(provider, MARKET, marketId);

// The real odds history — one point per bet, each with that moment's probabilities
const odds = oddsSeries(events, market.labels.length);
for (const point of odds) {
    console.log(`After bet #${point.index}: ${point.probabilities.map(p => (p * 100).toFixed(1) + "%")}`);
}

// Current implied probability of an outcome
const prob = impliedProbability(market.volumes[0], market.pot, market.labels.length);

// What 10 STRK on outcome 0 would return if it wins
const multiple = payoutMultiple(market.volumes[0], market.pot, 10n * STRK_UNIT, market.feeBps);
```

---

## Creating markets

```ts
import { createMarketCall, resolveCall, voidCall, collectFeeCall } from "veilcast-sdk";

// Open a binary market, resolver is the opener, closes in 7 days
const call = createMarketCall(
    MARKET,
    "Will ETH hit $5000 by Friday?",
    ["Yes", "No"],
    account.address,       // resolver
    closeAt,               // unix timestamp
    "Crypto",              // category (shown on the board)
    100,                   // fee: 1% (100 bps)
    account.address        // fee recipient
);
await account.execute([call]);

// Settle the market (resolver only)
await account.execute([resolveCall(MARKET, marketId, /* outcome */ 0)]);

// Void a market (all stakes refundable)
await account.execute([voidCall(MARKET, marketId)]);

// Collect the opener's fee after resolution (anyone can send)
await account.execute([collectFeeCall(MARKET, marketId)]);
```

---

## Price markets (Pragma oracle)

```ts
import {
    openPriceMarketCall,
    settleCall,
    loadPriceQuestion,
    loadMedian,
    formatPrice,
    parseThreshold,
    OUTCOME_AT_OR_ABOVE,
    OUTCOME_BELOW,
} from "veilcast-sdk";

// Open a market that settles from the STRK/USD feed
const call = openPriceMarketCall(
    RESOLVER,                          // PragmaResolver address
    "STRK above $0.50 by Friday?",     // question
    "Yes (≥ $0.50)",                   // label for at-or-above
    "No (< $0.50)",                    // label for below
    closeAt,                           // unix timestamp
    "Crypto",                          // category
    "STRK/USD",                        // Pragma pair
    parseThreshold("0.50", 8)!,        // threshold at 8 decimals
    0                                  // fee
);
await account.execute([call]);

// Anyone settles it after close — no permission needed
await account.execute([settleCall(RESOLVER, marketId)]);

// Read what the feed says right now
const median = await loadMedian(provider, RESOLVER, "STRK/USD");
console.log(`STRK/USD: $${formatPrice(median.price, median.decimals)}`);

// Read the question a market is bound to
const question = await loadPriceQuestion(provider, RESOLVER, marketId);
// → { ticker: "STRK/USD", threshold: 50000000n }
```

---

## Committee markets (jury resolution)

```ts
import {
    openCommitteeMarketCall,
    voteCall,
    loadCommittee,
    loadTally,
    loadBallot,
    parseJurors,
    VOID_CHOICE,
    MAX_JURORS,
} from "veilcast-sdk";

// Open a market judged by 3 jurors, needing 2 to agree
const call = openCommitteeMarketCall(
    COMMITTEE,                          // CommitteeResolver address
    "Who wins the election?",           // question
    ["Alice", "Bob", "Neither"],        // outcomes
    closeAt,
    "Politics",
    0,                                  // fee
    [juror1, juror2, juror3],           // panel addresses
    2                                   // quorum
);
await account.execute([call]);

// A juror casts their vote (0 = Alice, 1 = Bob, 2 = Neither, 255 = void)
await account.execute([voteCall(COMMITTEE, marketId, 0)]);

// Read the panel state
const committee = await loadCommittee(provider, COMMITTEE, marketId);
// → { nJurors: 3, quorum: 2, nOutcomes: 3, closeAt: ..., decided: false }

// Read the vote tally
const tally = await loadTally(provider, COMMITTEE, marketId, 3);
// → { perOutcome: [1, 0, 0], void: 0 }

// Check one juror's ballot
const ballot = await loadBallot(provider, COMMITTEE, marketId, juror1);
// → { juror: "0x...", isJuror: true, hasVoted: true, choice: 0 }

// Parse a textarea of addresses
const { jurors, invalid } = parseJurors("0xabc, 0xdef\n0x123");
```

---

## Coupon management

```ts
import { newCoupon, claimMessageHash, betCalldata, claimIntoNoteCalldata, openNotePlaceholder } from "veilcast-sdk";

// Generate a fresh coupon
const coupon = newCoupon(marketId, outcome, amount);
// → { marketId, outcome, privateKey, positionKey, amount, createdAt }

// The hash the contract checks (for custom signing flows)
const msgHash = claimMessageHash(MARKET, marketId, outcome, coupon.positionKey, "0x0");

// Raw calldata (if building action lists manually)
const betCd = betCalldata(coupon);     // [0, market_id, outcome, amount, position_key]
const claimCd = claimIntoNoteCalldata(coupon, MARKET, 0);  // [1, ...]
```

---

## Constants and utilities

```ts
import {
    STRK_TOKEN,
    STRK20_POOL_MAINNET,
    PRAGMA_ORACLE_MAINNET,
    PRAGMA_ORACLE_SEPOLIA,
    STRK_UNIT,
    formatStrk,
    parseStrk,
    encodeCategory,
    decodeCategory,
} from "veilcast-sdk";

formatStrk(5000000000000000000n);  // "5"
formatStrk(1234560000000000n);     // "0.0012"
parseStrk("2.5");                   // 2500000000000000000n
parseStrk("abc");                   // null

encodeCategory("DeFi");            // short-string felt
decodeCategory(0x44654669n);       // "DeFi"
```

---

## What is public and what is not

Read this before you build on it:

| 🔓 Public | 🔒 Private |
|---|---|
| Each bet's amount and the outcome it backs | Who placed it |
| Per-outcome volume and the odds off it | The link between one person's bets |
| A market's question, resolver and settlement | The link between a winning position and the collecting wallet |

A shield deposit into the pool is public and screened. The privacy begins after that. Do not build a
product whose privacy claim depends on the deposit being hidden.

---

## Example

`examples/read-board.ts` prints a deployment's board and one market's odds history, read-only, no
wallet:

```bash
npx tsx examples/read-board.ts --market 0x... --rpc https://rpc.starknet.lava.build
```

---

## Correctness

The calldata and payout math in this SDK are written against the same contract the app and the
Cairo tests target, and **pinned to shared test vectors**: the claim-message hash and the parimutuel
payout are asserted against one shared felt in three places (the contract, the app, and this SDK),
so a drift in any one fails a test rather than a transaction.

Run the SDK tests:

```bash
cd sdk && npx vitest run
```

---

## Full API reference

### Reads

| Function | Returns | Description |
|----------|---------|-------------|
| `loadBoard(provider, address, limit?)` | `MarketView[]` | Newest markets, newest first |
| `loadMarket(provider, address, marketId)` | `MarketView \| undefined` | One market by id |
| `loadStake(provider, address, marketId, outcome, positionKey)` | `bigint` | On-chain stake for a coupon |
| `loadMarketEvents(provider, address, marketId)` | `MarketEvent[]` | Full event history |
| `oddsSeries(events, nOutcomes)` | `OddsPoint[]` | Odds history rebuilt from events |
| `loadPriceQuestion(provider, address, marketId)` | `PriceQuestion \| undefined` | Feed question |
| `loadMedian(provider, address, ticker)` | `Median` | Current oracle price |
| `loadCommittee(provider, address, marketId)` | `Committee \| undefined` | Panel config |
| `loadTally(provider, address, marketId, nOutcomes)` | `{ perOutcome, void }` | Vote counts |
| `loadBallot(provider, address, marketId, account)` | `Ballot` | One juror's vote |

### Actions (private, via STRK20 pool)

| Function | Description |
|----------|-------------|
| `betActions(token, market, coupon)` | Place a bet through the pool |
| `claimIntoNoteActions(token, market, coupon, recipient)` | Collect into a private note |
| `batchClaimIntoNotesActions(token, market, coupons, recipient)` | Collect many at once |
| `claimToWalletActions(market, coupon, recipient)` | Collect to a public address |

### Calls (public, via `account.execute`)

| Function | Description |
|----------|-------------|
| `createMarketCall(...)` | Open a new market |
| `resolveCall(address, marketId, outcome)` | Settle a market |
| `voidCall(address, marketId)` | Cancel a market |
| `collectFeeCall(address, marketId)` | Pay the opener's fee |
| `openPriceMarketCall(...)` | Open a feed-settled market |
| `settleCall(address, marketId)` | Settle from oracle (permissionless) |
| `openCommitteeMarketCall(...)` | Open a jury-settled market |
| `voteCall(address, marketId, choice)` | Cast a juror's vote |

### Coupon

| Function | Description |
|----------|-------------|
| `newCoupon(marketId, outcome, amount)` | Generate a fresh position key |
| `claimMessageHash(market, id, outcome, key, target)` | The hash the contract verifies |
| `betCalldata(coupon)` | Raw calldata for a bet invoke |
| `claimIntoNoteCalldata(coupon, market, noteIndex?)` | Raw calldata for a note claim |
| `claimToAddressCalldata(coupon, market, recipient)` | Raw calldata for an address claim |

### Constants

| Export | Value |
|--------|-------|
| `STRK_TOKEN` | STRK ERC-20 address (both networks) |
| `STRK20_POOL_MAINNET` | The live STRK20 pool |
| `PRAGMA_ORACLE_MAINNET` | Pragma oracle (mainnet) |
| `PRAGMA_ORACLE_SEPOLIA` | Pragma oracle (Sepolia) |
| `STRK_UNIT` | `10n ** 18n` |

### Utilities

| Function | Description |
|----------|-------------|
| `formatStrk(amount, maxFractionDigits?)` | Wei → human-readable STRK |
| `parseStrk(input)` | Human input → wei (or null) |
| `encodeCategory(str)` | Category string → felt |
| `decodeCategory(felt)` | Felt → category string |
| `formatPrice(price, decimals)` | Oracle price → readable |
| `parseThreshold(input, decimals)` | Human input → feed units (or null) |
| `impliedProbability(volume, pot, n)` | Volume → probability (0–1) |
| `payoutMultiple(volume, pot, stake, fee?)` | → payout as multiple of stake |
| `quotePayout(view, outcome, stake)` | → expected payout in wei |
| `settledPayout(view, outcome, stake)` | → actual payout after resolution |
| `positionStatus(view, outcome, stake, claimed)` | → lifecycle status |

---

## License

MIT
