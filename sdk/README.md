# veilcast-sdk

Read and drive [Veilcast](https://github.com/zkasuran/veilcast), the private prediction market on
Starknet's STRK20 pool, from any TypeScript app or bot.

The design in one line: amounts and odds are public so the price signal is honest, and who bet is
not. This SDK never asks for a wallet address for a bet. It builds the STRK20 action lists the
privacy pool runs on your behalf, so the on-chain sender is the pool's relayer.

```bash
npm install veilcast-sdk starknet
```

`starknet` (v10) is a peer dependency. The SDK ships the contract ABIs, so you need nothing else.

## Three kinds of export

**Reads** take a starknet.js provider and hand back plain data.

```ts
import { RpcProvider } from "starknet";
import { loadBoard, loadMarketEvents, oddsSeries, formatStrk } from "veilcast-sdk";

const provider = new RpcProvider({ nodeUrl: "https://api.cartridge.gg/x/starknet/sepolia" });
const board = await loadBoard(provider, MARKET_ADDRESS);      // newest markets, decoded
for (const m of board) console.log(m.question, formatStrk(m.pot), m.state);

const events = await loadMarketEvents(provider, MARKET_ADDRESS, board[0].id);
const odds = oddsSeries(events, board[0].labels.length);      // the real odds history, no indexer
```

**Actions** return the STRK20 action list you pass to `walletAccount.strk20InvokeTransaction`. This
is how a bet or a claim stays private: the pool moves the money and invokes the market atomically.

```ts
import { newCoupon, betActions, batchClaimIntoNotesActions, STRK_TOKEN } from "veilcast-sdk";

// A coupon is the bearer of the position. Save it before you send anything; it is the only thing
// that can collect, and it lives nowhere but where you keep it.
const coupon = newCoupon(marketId, /* outcome */ 0, 5n * 10n ** 18n);
const actions = betActions(STRK_TOKEN, MARKET_ADDRESS, coupon);
const { transaction_hash } = await walletAccount.strk20InvokeTransaction(actions);

// Collect several winning or refundable positions in one transaction, each into its own note.
const claim = batchClaimIntoNotesActions(STRK_TOKEN, MARKET_ADDRESS, myCoupons, myAddress);
await walletAccount.strk20InvokeTransaction(claim);
```

**Calls** return a `Call` for `account.execute`, for the public admin a market allows: opening,
resolving, voiding, collecting a fee, opening a feed or committee market, voting.

```ts
import { createMarketCall, resolveCall, openPriceMarketCall, voteCall } from "veilcast-sdk";

await account.execute([createMarketCall(MARKET, "Will it rain Friday?", ["Yes", "No"], account.address, closeAt, "Weather")]);
await account.execute([resolveCall(MARKET, marketId, 0)]);
```

## What is public and what is not

Read this before you build on it. STRK20 gives identity privacy, not amount privacy, and Veilcast is
built around exactly that split.

| Public | Private |
|---|---|
| Each bet's amount and the outcome it backs | Who placed it |
| Per-outcome volume and the odds off it | The link between one person and their bets |
| A market's question, resolver and settlement | The link between a winning position and the wallet that collects |

A shield deposit into the pool is public and screened. The privacy begins after that. Do not build a
product whose privacy claim depends on the deposit being hidden.

## Settlement

A market names one resolver. This SDK covers all three routes Veilcast ships:

- a **single resolver** (`resolveCall` / `voidCall`): whoever the market names settles it.
- a **Pragma feed** (`openPriceMarketCall` / `settleCall` / `loadMedian`): bound to a pair and a
  threshold, settled by anyone from the feed once it closes.
- a **juror committee** (`openCommitteeMarketCall` / `voteCall` / `loadCommittee`): a named panel
  votes, and the first choice to reach the quorum settles it.

## Reference addresses

`STRK_TOKEN`, `STRK20_POOL_MAINNET`, `PRAGMA_ORACLE_MAINNET` and `PRAGMA_ORACLE_SEPOLIA` are exported
for convenience. The Veilcast market and resolver addresses are per-deployment, so you pass them in.

## Example

`examples/read-board.ts` prints a deployment's board and one market's odds history, read-only, no
wallet:

```bash
npx tsx examples/read-board.ts --market 0x... --rpc https://api.cartridge.gg/x/starknet/sepolia
```

## Correctness

The calldata and payout math here are written against the same contract the app and the Cairo tests
target, and pinned to the same fixed vectors: the claim-message hash and the parimutuel payout are
asserted against one shared number in three places (the contract, the app, and this SDK), so a drift
in any one fails a test rather than a transaction.

## License

MIT.
