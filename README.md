# Veilcast

Private prediction markets on Starknet. Visible odds, invisible bettors.

> Built for the STRK20 Private Sprint. Runs against the live STRK20 privacy pool on Starknet.

## What it is

Veilcast is a prediction market where the crowd's information stays public and the crowd stays anonymous. Anyone can read the odds, the per-outcome volume and how the market is moving. Nobody can see who placed a given bet or link one bet to another. When a market resolves, winners collect privately.

A prediction market only works when the price signal is honest. That needs open volume so the odds mean something. It breaks when large players can be tracked, because visible whales cause herding and front-running, which scares off the flow that makes the price accurate. STRK20 lets Veilcast keep both halves: the amounts stay public so the odds are real, the identities stay private so the signal stays clean.

## Why it needs privacy and what is actually private

STRK20 gives identity privacy, not amount privacy. Veilcast is designed around exactly that split. Being precise here matters for users and for judging. Overclaiming what is hidden is dishonest and it is the fastest way to get the privacy model wrong.

| Public | Private |
|---|---|
| Each bet's amount and the outcome it backs | Who placed the bet (the on-chain sender is a shared relayer, never the bettor) |
| Per-outcome volume and the live odds derived from it | The link between a bettor and their bets across markets |
| The resolution and the oracle or resolver that produced it | The link between a winning position and the wallet that claims it |
| A shield deposit: the depositor address, token and amount | A claim payout, routed as a private note-to-note transfer |

Amounts are deliberately public. That is not a limitation we are hiding, it is the design: a market with hidden sizes cannot produce accurate odds. What Veilcast removes is the identity layer, so flow drives price without letting anyone build a profile of who bets on what.

Shielding into the pool is a public, compliance-screened deposit. The privacy begins after that, once the balance is a private note. Veilcast never claims the deposit itself is hidden.

## How it works

Veilcast builds on the STRK20 privacy pool and the starter kit's `privacy_invoke` pattern.

1. Shield. A user shields STRK into the pool once. This is a normal public deposit, screened on-chain. It credits the user a private note.
2. Place a bet. To bet, the pool withdraws the stake into the Veilcast market contract inside one atomic `privacy_invoke` call. The contract records the stake against the chosen outcome and adds it to that outcome's public volume. The transaction is submitted by a rotating shared relayer, so the on-chain sender is the relayer and the bettor's address appears nowhere. The amount and the outcome are public. The bettor is not.
3. Watch the odds. Odds are read straight off the public per-outcome volume, so the market stays informationally efficient. Everyone sees the same numbers.
4. Resolve. Each market binds to a resolution source when it is created. Price questions resolve from a Pragma oracle feed. Non-price questions resolve from a named resolver or a vote. Resolution is on-chain and verifiable.
5. Claim. A winner redeems their position and the payout leaves as a private note-to-note transfer, so the amount and the parties stay hidden and the payout cannot be linked back to the original bet.

Auditability is preserved through STRK20 viewing keys. A user can disclose their own activity when they need to, which keeps the market usable where disclosure is required without making everything public by default.

The market logic lives in a Cairo contract that implements the pool's `privacy_invoke` interface. The starter kit ships an echo helper with that shape; Veilcast replaces the echo body with real market accounting (outcomes, per-outcome volume, resolution and claims). The frontend is the starter kit's WalletAccountV6 flow, so every action goes through the user's wallet and the app never touches a viewing key.

## Stack

- Cairo contract (Scarb, Starknet Foundry) implementing the STRK20 `privacy_invoke` interface.
- Pragma oracle for price-based resolution.
- Next.js 16, React 19, TypeScript, starknet.js 10, zustand. No component framework.
- The live STRK20 pool on Starknet.

## Running locally (Sepolia)

```bash
npm install
cp .env.example .env.local     # add a Starknet RPC key
npm run dev                    # http://localhost:3000
```

Needs a privacy-enabled Starknet wallet (Ready) on Sepolia. During the sprint the app is developed against Sepolia, where the STRK20 discovery and proving endpoints are hosted, then pointed at mainnet.

## Mainnet

Verified values for the live STRK20 pool:

```
CHAIN_ID     = SN_MAIN
RPC_URL      = https://rpc.starknet.lava.build
POOL_ADDRESS = 0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
```

The market contract address and the mainnet transaction hashes land in `strk20.json` as they are produced.

## strk20.json

The hub reads this file from the repo root. It carries the deployed contract addresses, the mainnet transaction hashes that prove the app runs against the pool, the demo video and the demo URL. Fields fill in as the build reaches mainnet.

## Status

Early build for the STRK20 Private Sprint. Developed on Sepolia first, then flipped to the live mainnet pool.

## Credits and disclosure

Bootstrapped from the STRK20 starter kit by Akashneelesh, itself based on [PhilippeR26/Starknet-WalletAccount](https://github.com/PhilippeR26/Starknet-WalletAccount). Built on [STRK20](https://strk20.starknet.io) by StarkWare.

AI assistance (Claude) was used while building Veilcast. The design, the privacy model and the verification are owned by the author.
