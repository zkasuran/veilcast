# 🏆 VeilCast — Private Sprint Hackathon Roadmap

> **Goal:** Win the STRK20 Private Sprint ($5,000 prize pool)
> **Deadline:** August 31, 2026
> **Today:** August 23, 2026 (Day 0)
> **Days remaining:** 8

---

## 📊 Current State Assessment

| Layer | Status | Score |
|-------|--------|-------|
| Cairo contracts (market + 2 resolvers) | ✅ Complete, 35 tests green | 10/10 |
| TypeScript SDK (`veilcast-sdk`) | ✅ Complete, pinned test vectors | 10/10 |
| Frontend (board, bets, positions, charts, vault) | ✅ Functional, light-only | 7/10 |
| Dark/Light mode | ❌ Missing | 0/10 |
| Contract deployment (Sepolia + Mainnet) | ❌ Not deployed | 0/10 |
| `strk20.json` (sprint hub manifest) | ❌ Empty | 0/10 |
| 3 mainnet pool transactions | ❌ Not done | 0/10 |
| Demo video | ❌ Not recorded | 0/10 |
| README (hackathon-grade) | ⚠️ Good but not visual/punchy | 6/10 |
| Responsive design polish | ⚠️ Partial | 7/10 |
| Live demo (GitHub Pages) | ✅ Working | 9/10 |
| CI/CD (contracts + pages) | ✅ Full pipeline | 10/10 |

**Verdict:** The architecture and logic are hackathon-winning quality. What's missing is the **presentation layer** (dark mode, README aesthetics, demo video) and the **proof of life** (deployment, mainnet transactions, filled `strk20.json`).

---

## 🎯 Judging Criteria Alignment

Based on the STRK20 Private Sprint rules (source: [strk20.starknet.io/hackathon](https://strk20.starknet.io/hackathon)):

| Criterion | How VeilCast Wins |
|-----------|-------------------|
| **Privacy usage** | Core product — every bet is a STRK20 pool action, bettors are invisible |
| **Working product** | Full flow: shield → bet → read odds → resolve → claim privately |
| **Latest code push** | Leaderboard rewards activity — daily pushes scheduled |
| **Mainnet transactions** | 3+ real pool txs prove it works against the live pool |
| **RFP alignment** | Matches "Private Prediction Market" RFP word-for-word |
| **Innovation** | Parimutuel + bearer coupons + committee/oracle dual resolver |
| **Code quality** | TypeScript strict, Cairo tested, SDK with pinned vectors |
| **UX polish** | Dark/light toggle, responsive, onboarding walkthrough, QR sharing |

---

## 📅 Daily Roadmap — 8 Days to Victory

---

### 🗓️ Day 1 — Sunday, August 24
## **Theme: 🌗 Dark Mode & Design System Overhaul**

**Why first:** Visual impact is immediate. Judges see the UI before reading code. A polished dark/light toggle signals professional quality.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Add CSS custom properties for dark theme in `globals.css` | Complete dark palette (`--ink`, `--bg`, `--card`, `--line`, etc.) |
| 2 | Add `data-theme` attribute toggle on `<html>` | Theme state persisted in `localStorage` |
| 3 | Create `ThemeToggle` component (sun/moon icon button in nav) | Animated icon switch, accessible |
| 4 | Update `uni.module.css` to use CSS variables everywhere (replace any hardcoded colors) | Zero hardcoded `#fff` or `#0d0e0e` |
| 5 | Dark aurora background (deeper blurred orbs, darker canvas) | Atmospheric dark mode background |
| 6 | Dark mode for modals, cards, wallet picker, receipts | Every component respects theme |
| 7 | Dark mode for odds chart (axis labels, grid lines, tooltip) | Chart readable in both modes |
| 8 | Test both modes on mobile viewport (375px) | No broken layouts in dark |

**Push:** `feat: dark/light mode toggle with full theme system`

**Banger update:** *"VeilCast now ships a complete dark/light mode. Every component, chart, and modal responds to your preference. The prediction market that respects your privacy also respects your eyes."* 🌙

---

### 🗓️ Day 2 — Monday, August 25
## **Theme: 📱 Responsive Polish & Micro-Interactions**

**Why now:** After dark mode, the next biggest visual differentiator is smooth, responsive interactions.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Audit every component at 375px, 768px, 1024px, 1440px | Fix any overflow, truncation, or cramping |
| 2 | Add skeleton loading states for board, market detail, positions | Pulsing placeholders while RPC loads |
| 3 | Add subtle entrance animations to market cards (staggered fade-in) | CSS `@keyframes` with `animation-delay` |
| 4 | Animate tab switches (crossfade or slide) | Smooth panel transitions |
| 5 | Add haptic-style button press feedback (scale + shadow shift) | Tactile feel on all interactive elements |
| 6 | Improve the hero section — animated gradient text or typewriter | Eye-catching above the fold |
| 7 | Add toast notifications for actions (bet placed, coupon backed up) | Non-blocking, auto-dismiss, themed |
| 8 | Mobile bottom navigation bar for small screens | Thumb-friendly tab access |

**Push:** `feat: responsive polish, skeleton loaders, micro-interactions`

**Banger update:** *"Buttery smooth on every screen. Skeleton loaders, staggered animations, mobile-first bottom nav. VeilCast feels like a $100M product, not a hackathon project."* ✨

---

### 🗓️ Day 3 — Tuesday, August 26
## **Theme: 🚀 Deploy Contracts (Sepolia First)**

**Why now:** Frontend is polished. Time to bring the contracts to life.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Fund a Sepolia deployer account | Account with testnet STRK |
| 2 | Declare + deploy `VeilcastMarket` on Sepolia | Class hash + contract address |
| 3 | Declare + deploy `PragmaResolver` on Sepolia | Working against Sepolia Pragma feeds |
| 4 | Declare + deploy `CommitteeResolver` on Sepolia | Ready for jury markets |
| 5 | Create a test market via the app (connect wallet, submit) | First market live on testnet |
| 6 | Place a test bet through the STRK20 pool | Verify full privacy flow |
| 7 | Update `.env` and GitHub repo variables with Sepolia addresses | CI/CD builds point to live contracts |
| 8 | Update `cairo/address.md` with all Sepolia addresses | Documentation reflects reality |

**Push:** `deploy: contracts live on Sepolia, first market created`

**Banger update:** *"VeilCast is LIVE on Sepolia. Three contracts deployed, first market created, first private bet placed. The prediction market that hides you is real."* 🎯

---

### 🗓️ Day 4 — Wednesday, August 27
## **Theme: 🌐 Mainnet Deployment + Pool Transactions**

**Why now:** The leaderboard rewards mainnet proof. This is the #1 differentiator.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Fund mainnet deployer with real STRK | Ready to deploy |
| 2 | Declare + deploy `VeilcastMarket` on Mainnet | Production contract address |
| 3 | Declare + deploy `PragmaResolver` on Mainnet | Live against mainnet Pragma |
| 4 | Declare + deploy `CommitteeResolver` on Mainnet | Production jury resolver |
| 5 | Shield STRK into the STRK20 pool (tx #1) | First mainnet pool transaction |
| 6 | Place a real bet on a real market (tx #2) | Private bet via pool relayer |
| 7 | Claim a payout or perform another pool action (tx #3) | Third pool transaction |
| 8 | Fill `strk20.json` with all addresses + tx hashes | Sprint hub manifest complete |

**Push:** `deploy: mainnet live — 3 pool transactions, strk20.json filled`

**Banger update:** *"VeilCast is on MAINNET. Three real STRK20 pool transactions prove it works against the live privacy pool. Contracts declared, markets running, bets flowing privately."* 🔥

---

### 🗓️ Day 5 — Thursday, August 28
## **Theme: 📖 Banger README + Documentation Overhaul**

**Why now:** Judges read the README first. It needs to sell the project in 30 seconds.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | New README header: logo, badges (build, tests, deploy), one-liner | Instant credibility |
| 2 | "What is VeilCast?" section with architecture diagram (Mermaid) | Visual system overview |
| 3 | "Privacy Model" section with clear public/private table | Judges understand the split instantly |
| 4 | "How It Works" visual flow (numbered steps with emoji) | 5-step flow from shield to claim |
| 5 | Screenshots section (light + dark mode, mobile + desktop) | Visual proof of quality |
| 6 | "Tech Stack" badges section (Next.js, Cairo, STRK20, etc.) | Modern badge row |
| 7 | "Live Demo" + "Contracts" sections with clickable links | One-click to verify |
| 8 | "For Judges" TL;DR section at the very top | 10-second pitch for evaluators |
| 9 | SDK README update with usage examples | Developer-friendly |
| 10 | Add `ARCHITECTURE.md` with detailed system design | Deep-dive for technical judges |

**Push:** `docs: hackathon-grade README, architecture docs, screenshots`

**Banger update:** *"README rewritten from scratch. Architecture diagrams, screenshots, badges, live links. If the code doesn't convince you, the docs will."* 📚

---

### 🗓️ Day 6 — Friday, August 29
## **Theme: 🎬 Demo Video + Final UX Features**

**Why now:** Video is the ultimate proof of a working product. Also, time to add any missing UX touches.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Script the demo video (60–90 seconds) | Clear narrative arc |
| 2 | Record: connect wallet → shield → create market → bet | Shows the full flow |
| 3 | Record: read odds → resolve → claim privately | Shows the payout privacy |
| 4 | Record: dark mode toggle, mobile view, positions tab | Shows polish |
| 5 | Edit with captions, transitions, background music | Professional quality |
| 6 | Upload to YouTube/Loom, add link to `strk20.json` | Sprint hub picks it up |
| 7 | Add "Watch Demo" button to the app header | CTA for visitors |
| 8 | Add any missing error states, empty states, edge-case UX | No dead ends in the UI |

**Push:** `feat: demo video linked, UX edge cases polished`

**Banger update:** *"90-second demo video showing the full private prediction market flow. Shield, bet, read, resolve, claim — all private, all on mainnet."* 🎬

---

### 🗓️ Day 7 — Saturday, August 30
## **Theme: 🧪 Hardening, Testing & Performance**

**Why now:** Last full dev day. Everything must be bulletproof.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Run full test suite (Cairo + TS), fix any failures | All green |
| 2 | Add integration smoke test: board loads, market detail loads | Basic E2E confidence |
| 3 | Lighthouse audit — target 95+ on Performance, A11y, Best Practices | Score screenshots for README |
| 4 | Bundle size audit — ensure no unnecessary deps | Lean production build |
| 5 | Security review: no private keys in code, CSP headers, input sanitization | No embarrassing leaks |
| 6 | Test with Ready wallet on mainnet — full flow | Real-user validation |
| 7 | Fix any visual bugs caught during recording/testing | Pixel-perfect |
| 8 | Update all links: demo URL, contract explorer links, video | Everything clickable and live |

**Push:** `chore: hardening pass — tests green, lighthouse 95+, security reviewed`

**Banger update:** *"Every test green. Lighthouse 95+. Security reviewed. Zero hardcoded secrets. VeilCast is production-grade, not prototype-grade."* 🛡️

---

### 🗓️ Day 8 — Sunday, August 31 (DEADLINE)
## **Theme: 🏁 Final Push & Submission**

**Why now:** It's submission day. Ship everything, verify the leaderboard, submit.

| # | Task | Deliverable |
|---|------|-------------|
| 1 | Final `strk20.json` verification — all fields filled | Sprint hub reads correct data |
| 2 | Final push to `main` — triggers Pages deployment | Live demo is latest code |
| 3 | Verify GitHub Pages demo loads correctly | No 404s, no broken assets |
| 4 | Verify all mainnet contract links work on Voyager/Starkscan | Contracts verifiable |
| 5 | Double-check demo video link works | Judges can watch |
| 6 | Write a Twitter/X thread announcing the submission | Community visibility |
| 7 | Submit to the sprint hub / leaderboard | DONE |
| 8 | Celebrate 🎉 | You shipped a privacy app on Starknet |

**Push:** `chore: final submission — strk20.json complete, all links verified`

**Banger update:** *"VeilCast submitted to the STRK20 Private Sprint. Private prediction markets, live on mainnet, dark mode, open SDK, full docs. Visible odds, invisible bettors."* 🏆

---

## 🔑 Key Differentiators That Win

### vs. Other Hackathon Projects:

| Advantage | Why It Matters |
|-----------|---------------|
| **Matches an official RFP** | "Private Prediction Market" is listed — judges look for this |
| **Actually uses STRK20 privacy** | Not a wrapper, not a mock — real pool transactions |
| **Dual resolver system** | Pragma oracle + committee jury — covers all market types |
| **Bearer coupon system** | Novel, unlinkable position ownership |
| **Full SDK for ecosystem** | Other teams can build on your work |
| **Parimutuel math** | No orderbook, no counterparty matching needed |
| **Dark/light mode** | Shows professional frontend craft |
| **35 Cairo tests + 94 TS tests** | Production quality, not hackathon spaghetti |
| **Static export** | No server needed, infinite scaling, censorship-resistant |
| **3 mainnet transactions** | Proof of life that most projects won't have |

---

## 📝 Daily Push Schedule (Leaderboard Optimization)

The leaderboard rewards the **latest code push**. Strategy: push meaningful commits daily, never batch.

| Day | Time | Branch | Merge to Main |
|-----|------|--------|---------------|
| Day 1 (Aug 24) | Evening | `feat/dark-mode` | Yes, same day |
| Day 2 (Aug 25) | Evening | `feat/responsive-polish` | Yes, same day |
| Day 3 (Aug 26) | Evening | `deploy/sepolia` | Yes, same day |
| Day 4 (Aug 27) | Evening | `deploy/mainnet` | Yes, same day |
| Day 5 (Aug 28) | Evening | `docs/readme-overhaul` | Yes, same day |
| Day 6 (Aug 29) | Evening | `feat/demo-video` | Yes, same day |
| Day 7 (Aug 30) | Evening | `chore/hardening` | Yes, same day |
| Day 8 (Aug 31) | Morning | `chore/final-submission` | Yes, before deadline |

---

## 🛠️ Tech Stack Summary

```
┌─────────────────────────────────────────────────────┐
│  FRONTEND        Next.js 16 · React 19 · Zustand 5  │
│  STYLING         CSS Modules · CSS Variables · Dark  │
│  CONTRACTS       Cairo 2.20 · Scarb · snForge       │
│  SDK             TypeScript · starknet.js 10         │
│  PRIVACY         STRK20 Pool · Wallet API           │
│  ORACLE          Pragma (mainnet feeds)             │
│  DEPLOY          GitHub Pages (static export)        │
│  CI/CD           GitHub Actions (test + deploy)      │
│  TESTING         Vitest (TS) · snForge (Cairo)      │
└─────────────────────────────────────────────────────┘
```

---

## ⚡ Emergency Fallbacks

If something goes wrong:

| Risk | Fallback |
|------|----------|
| Mainnet deploy fails | Sepolia demo is still valid, note in README |
| Pragma feed unavailable | Committee resolver covers all markets |
| Ready wallet buggy | Document the flow, show code path |
| Dark mode breaks something | Ship it behind a feature flag |
| Demo video quality poor | Loom recording with voiceover is fine |
| Time crunch | Prioritize: mainnet txs > README > dark mode > video |

---

## 🏅 Priority Stack (If You Only Have Time For...)

1. **🔴 CRITICAL:** Deploy to mainnet + 3 pool transactions + fill `strk20.json`
2. **🟠 HIGH:** Dark/light mode toggle (visual differentiation)
3. **🟡 MEDIUM:** README overhaul with badges, diagrams, screenshots
4. **🟢 NICE:** Demo video, micro-interactions, Lighthouse optimization

The deployment + `strk20.json` is the single highest-leverage action. A working mainnet product with empty `strk20.json` won't place. A beautiful UI with filled `strk20.json` and 3 real transactions WILL.

---

## 📌 Submission Checklist

- [ ] All three contracts deployed to mainnet
- [ ] 3+ mainnet STRK20 pool transactions recorded
- [ ] `strk20.json` filled with addresses, tx hashes, demo URL, video
- [ ] GitHub Pages demo live and working
- [ ] Dark/light mode functional
- [ ] README is hackathon-grade (badges, diagrams, screenshots, links)
- [ ] Demo video uploaded and linked
- [ ] All tests passing (Cairo + TypeScript)
- [ ] `typecheck` passing
- [ ] Final push to `main` before deadline

---

*Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon). Visible odds, invisible bettors.*
