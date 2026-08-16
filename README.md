# Veilcast

Private prediction markets on Starknet. Visible odds, invisible bettors.

> Built for the STRK20 Private Sprint, against the live STRK20 privacy pool.

## What it is

Veilcast is a prediction market where the crowd's information stays public while the crowd stays
anonymous. Anyone can read the odds, the volume behind each outcome and how a market is moving.
Nobody can see who placed a bet, tie two bets to one person or tie a payout back to the bet that
earned it.

A prediction market is only worth reading when its price signal is honest, and an honest signal
needs open volume. It breaks the other way when large players can be tracked: visible whales cause
herding and front-running, which drives off the flow that makes the price accurate in the first
place. STRK20 lets Veilcast keep both halves. Amounts stay public so the odds are real, identities
stay private so the flow stays honest.

## What is public and what is private

STRK20 gives identity privacy, not amount privacy. Veilcast is built around exactly that split.
Overclaiming here would be dishonest, and it is also the fastest way to design the thing wrong.

| Public | Private |
|---|---|
| Each bet's amount and the outcome it backs | Who placed it. The market contract is never told an address |
| Per-outcome volume and the odds that come off it | The link between one person and their bets, across markets and inside one |
| Every market's question, resolver and settlement | The link between a winning position and the wallet that collects it |
| A shield deposit: the depositor, the token, the amount | A payout, when it is collected into a private note |

Amounts are public on purpose. A market with hidden sizes cannot produce accurate odds, so hiding
them would break the product to advertise a stronger privacy claim. What Veilcast removes is the
identity layer.

Shielding into the pool is a public, screened deposit. The privacy starts after that, once the
balance is a private note.

## How a bet works

1. **Shield.** Deposit STRK into the pool once. Public, screened on-chain. You now hold a private
   note.
2. **Bet.** One pool transaction does two things in one atomic step: the pool withdraws your stake
   into the market contract, then it invokes the market to book it. The sender recorded on-chain is
   the pool's rotating relayer, so your address appears nowhere. The market is handed an amount, an
   outcome and a public key it has never seen before.
3. **Read the odds.** Per-outcome volume is public, so the implied probability and the payout
   multiple are the same numbers for everyone looking.
4. **Resolve.** The market's named resolver settles it after it closes, on-chain and in public.
5. **Collect.** A winner signs their coupon and the payout lands in a fresh open note inside the
   pool, which is a private note-to-note transfer. Collecting to a public address is offered too,
   clearly labelled, because sometimes that is what you want.

### The coupon is the position

Nothing on-chain ties a position to an account, which means there is no account to look positions up
by. When you bet, the browser generates a Stark keypair, sends the public half with the bet and keeps
the private half in localStorage. Collecting means signing a message with that key.

That is what makes the payout unlinkable: the coupon key is fresh per bet, so two bets by the same
person share nothing on-chain, and the claim carries no address.

It also means losing the coupon loses the payout, and anyone who holds a copy can collect. The
Positions tab has a one-click backup for that reason. Treat the file as the money.

A claim signature covers where the payout may go, so a relayer cannot redirect it. Signing for an
address binds the payout to that address, and signing for an open note is a bearer authorization
good only for the transaction carrying it, because the wallet picks the note id while it assembles
the transaction.

### Payouts are parimutuel

There is no counterparty to match and no order book. Every stake goes into one pot, and when the
market settles the whole pot is split across the winning side in proportion to stake. That is why
the odds move as volume arrives, and why the app quotes what a stake would pay including itself:
`stake * pot / winning_volume`, the same integer arithmetic the contract runs.

Two edges are handled rather than left to chance. A market resolved on an outcome nobody backed
voids instead of stranding the pot, so every stake becomes refundable. A resolver who goes silent
cannot lock the pot either: 30 days past the close, anyone can void the market.

### Resolution

Each market names one resolver address when it is created. Only that address can settle it. The
resolver is an address, not a person, so a contract can hold the role, which is the difference
between a market you have to trust and one you can check.

Whoever opens a plain market is its resolver, and the app says so on the form.

**Price markets settle themselves.** `cairo/src/pragma_resolver.cairo` is a resolver contract with no
admin and no owner. Opening a market through it binds the market to a Pragma spot pair and a
threshold, and afterwards anyone at all can push the feed's median in: at or above the threshold
settles the first outcome, below settles the second. Whoever sends that transaction pays the fee and
gets no say in the result. The contract refuses a median with no publishers behind it and one older
than the window it was deployed with, so a feed that has gone quiet cannot settle a market on a stale
number. It cannot void either, because a permissionless void would let anyone cancel a live market,
so a dead feed falls through to the market's own 30-day rule instead.

The Pragma interface is declared in this repo rather than pulled in as an SDK, and checked against
the live feeds: mainnet `0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b` answered
`get_data_median(SpotEntry('STRK/USD'))` on 2026-08-16 with 12 publishers at 8 decimals. The app
shows that median next to a price market before it settles, so the number that will decide the
question is visible in advance.

Resolution is deliberately public. The terms of a market are not the thing that needs hiding, and a
settlement nobody can point at is not a settlement. What stays private is who was on each side.

### The board is one call

`get_market_views(start, count)` returns each market with its question, its labels and its live
volumes in a single read, so a page load is two RPC calls whatever the board size rather than four
per market plus one per outcome label.

## What runs today

| | |
|---|---|
| Cairo market contract | done, 24 tests green under Starknet Foundry |
| Pragma resolver contract | done, covered by those tests against a mock feed |
| App: board, bet, positions, private claim, feed settlement, pool actions | done, 36 tests green under vitest |
| Live demo | [zkasuran.github.io/veilcast](https://zkasuran.github.io/veilcast/), published from main |
| Declared and deployed | not yet, on either network |
| Three mainnet pool transactions | not yet |

Nothing is deployed yet, so both market addresses are still `0x0` and the board says so rather than
pretending to have one. Deploying spends real STRK on mainnet, so it happens once the contract is
final.

## Repo layout

```
cairo/src/market.cairo               the market: bets, volumes, resolution, claims
cairo/src/interface.cairo            the ABI, the calldata layout, the error codes
cairo/src/pragma_resolver.cairo      the feed resolver: bind a price question, settle it
cairo/src/pragma.cairo               the slice of the Pragma oracle this repo calls
cairo/src/tests/                     the contract's tests, including mocks of the pool and the feed
cairo/scripts/deploy.sh              declare and deploy against a pool
src/utils/veilcast.ts                coupons, claim signing, pool action lists, odds maths
src/utils/market.ts                  board reads, payout maths, the public calls
src/utils/resolver.ts                price questions, feed reads, settlement calls
src/app/components/client/market/    board, bet form, positions, resolver and feed controls
src/app/components/client/strk20/    the pool actions and the shared submit path
strk20.json                          what the sprint hub reads
```

## Running it

```bash
npm install
cp .env.example .env.local     # a Starknet RPC key, plus a market address once one is deployed
npm run dev                    # http://localhost:3000
```

Needs a privacy-enabled Starknet wallet (Ready) on Mainnet or Sepolia. The app never touches a
viewing key: proving and private state stay inside the wallet, which is the whole point of the STRK20
wallet API.

## Tests

```bash
cd cairo && snforge test   # the market, its guards, the whole path from bet to claim
npm test                   # signing, calldata, pool action lists, odds and payout maths
npm run typecheck
npm run build
```

The claim message hash is pinned on both sides of the wire.
`test_claim_message_hash_matches_the_frontend` in Cairo and the matching vector in
`src/utils/veilcast.test.ts` assert the same felt, so if either Poseidon implementation drifts a test
fails instead of every claim reverting on-chain.

## Deploying

```bash
sncast account import --name veilcast --address <account> --private-key <key> \
    --type <oz|argent|braavos> --network sepolia
cd cairo && VEILCAST_POOL=<pool address> ./scripts/deploy.sh sepolia
```

The market is bound to one pool and one token at construction and neither can change afterwards, so
that pair is the whole configuration. Record the address in `.env.local`, in `cairo/address.md` and
in `strk20.json`.

## strk20.json

The sprint hub reads this file from the repo root: the deployed contract addresses, the mainnet
transaction hashes that prove the app ran against the pool, the demo video, the demo URL. Fields fill
in as the build reaches mainnet.

## Credits and disclosure

Bootstrapped from the STRK20 starter kit by Akashneelesh, itself based on
[PhilippeR26/Starknet-WalletAccount](https://github.com/PhilippeR26/Starknet-WalletAccount). Built on
[STRK20](https://strk20.starknet.io) by StarkWare.

AI assistance (Claude) was used while building Veilcast. The design, the privacy model and the
verification are the author's.




