# AKINDO submission: Coil (Wave 2)

Wave 1 submission (19 Oct 2026): https://app.akindo.io/communities/kzmodr4eacd1Zpnve/products/WjDlXKe8pUvQkPBZ

## Form fields

- **Product name:** Coil
- **Tagline:** Leveraged Bitcoin on Mezo that survives redemptions: one transaction in, protected by a keeper while it lives.
- **Category:** leveraged BTC borrowing · redemption protection · yield (sMUSD)
- **Track:** Track 1 (DeFi)
- **Chain:** Mezo testnet (31611)
- **Status:** Wave 1 project, extended in Wave 2 (all Wave 2 work committed 4 Nov 2026 onward)
- **Readiness:** testnet deployment, live app, source-verified contract
- **Live app:** https://coil-mezo-blitz-bet.vercel.app/#/app
- **Proof (every transaction):** https://coil-mezo-blitz-bet.vercel.app/#/proof
- **Code:** https://github.com/Wilivms/Coil (commit judged: the latest on `main`; Wave 2 starts at 02f7583)
- **Deck (PDF in the repo):** https://github.com/Wilivms/Coil/blob/main/docs/Coil-deck.pdf
- **Video (1:42):** https://youtu.be/ld7dE8nHTlI
- **Contracts:** CoilRouter v4 `0x17e056ef7e076Fbcb806dF9916552A26Da527F03`, CoilLens `0xa82154DD7bf08840F4D9d97a44999C4D4F76d8f5` (both verified); v3 `0x7b3D…6Ac4` holds the full keeper E2E; v2 `0xa9ad…7a92` holds the first keeper-fired Guard

## TL;DR

Track 1 · Mezo testnet · Wave 1 project extended in Wave 2 · testnet deployment.
Coil opens a leveraged MUSD trove in one transaction, in the user's own name, then keeps it alive: Guard deleverages it before liquidation, and Shield repays it from a Reserve held in Mezo's sMUSD vault when the trove nears the front of the redemption queue or when MUSD enters Recovery Mode.

## Updates in this Wave (paste into "Updates in this Wave", 3,000 characters max)

LINKS
Video (1:42): https://youtu.be/ld7dE8nHTlI
App: https://coil-mezo-blitz-bet.vercel.app/#/app · Try: /#/try · Proof: /#/proof
Code: https://github.com/Wilivms/Coil · Deck: docs/Coil-deck.pdf · E2E: docs/e2e-testnet.md
CoilRouter v4 0x17e056ef7e076Fbcb806dF9916552A26Da527F03 + CoilLens 0xa821…d8f5, source-verified

WHY: on Mezo mainnet MUSD logged 1,279 redemptions vs 28 liquidations (5.94M MUSD, 79.6 BTC taken). They hit the lowest-ratio troves first. On testnet, a bot redeemed our test trove at the front of the queue in under 2 minutes. Coil is built for that.

WAVE 1 FEEDBACK
1. Keeper sandwich (High): fixed. Every swap is bounded by MUSD's PriceFeed and Guard stores a signed minBtcOut; the sandwich replay test reverts.
2. Recovery Mode: Shield, a signed RepayMUSD funded by a Reserve in Mezo's sMUSD (earns yield). Repay-only, so it works when Guard can't.
3. Keeper end to end: always-on GitHub Actions keeper (15 s). On v3 and v4 it fired Shields, a Recoil and Guards on its own.
4. Outside wallets: Guard/Shield now work on any MUSD trove; /try onboarding. Honest count on /proof.
5. Verify, video, no forced intro: done.

NEW IN WAVE 2
- Shield redemption trigger: fires when less than X MUSD stands ahead of the trove, proved on-chain by walking SortedTroves.
- Leverage up in one tx (adds a Refinance signature when MUSD's capacity is short) and Recoil, a signed leverage-up the keeper runs once the ratio is back.
- 0.05% of each coil's debt to the MUSD/BTC gauge, live.
- v4, found by our own E2E: the testnet pool drifted 5.5% from the oracle, past our 5% cap, and every coil reverted. Now the borrower may accept a wider gap (max 20%) on a trade they send; the app sets it from the live quote and shows it. Keeper flows stay on 3%: on-chain, fireRecoil was refused at that gap.
- App: cost vs the oracle (MUSD) before each signature; wait-or-act when the pool is past the keeper bound; fire-it-yourself; read-only ?address= view; live keeper health and mainnet queue on /proof.
- Owner behind a 24 h OpenZeppelin timelock: 0.10% fee live through it, E2E after shows 0.10% to treasury.

DECLARED GOALS: re-leverage in 1 tx done; Guard ladders and the x402 risk API moved to Wave 3, Shield came first.

TESTS: the app clicked through on testnet (docs/e2e-testnet.md); 28 app tests; 107 unit/fuzz/invariant (97% line coverage) + 9 fork tests on the real Mezo contracts, testnet and mainnet: Shield repays a real mainnet trove from mainnet sMUSD. CI on every push.

WHY NOT MAINNET: the mainnet MUSD/BTC pool holds 0.48 BTC; a 0.05 BTC flash pays ~12% over fair. The mainnet fork test shows Coil refuses it. Reserve and Shield need no pool and already pass on a mainnet fork.

BUSINESS: 0.10% open fee (0.5% cap), keeper bounties, interest to sMUSD.

DISCLOSURE: testnet only, not audited. All E2E txs are from team wallets, listed on /proof; outside wallets are counted apart. The owner is a 24 h OpenZeppelin timelock (fee and default tolerance only, within hard caps).

## How it works

The user signs one EIP-712 message. CoilRouter flash-borrows BTC from Mezo's MUSD/BTC pool, opens the trove in the user's name through `openTroveWithSignature`, and repays the pool with the MUSD the trove minted. Unwind and deleverage run the same path in reverse. Guard stores a signed partial deleverage with a trigger and a minimum BTC out; Shield stores a signed repayment funded by the Reserve. The keeper executes either when its condition holds, and the contract re-checks the condition itself.

## Target group

BTC holders who borrow MUSD or want leveraged BTC without selling, intermediate to advanced DeFi users, desktop and mobile web, worldwide. Also any existing MUSD borrower: Guard and Shield work on troves opened in the Mezo app.

## Tech stack

Solidity 0.8.24, Foundry (unit, fuzz, invariant and fork tests), EIP-712, Mezo Pools flash swaps, MUSD BorrowerOperationsSignatures, TroveManager, SortedTroves, PriceFeed, MUSDSavingsRate. React, Vite, wagmi, viem, RainbowKit. viem keeper on GitHub Actions. Blockscout for indexed history.

## Future milestones

1. Dec 2026: Shield ladders (several signed repays at stepped triggers) and Mezo Passport accounts.
2. Q1 2027: external audit; a second, independent keeper next to the GitHub Actions one.
3. 2027: Reserve and Shield on mainnet first (they need no pool, and pass on a mainnet fork today), then leverage once the MUSD/BTC pool can take positions without double-digit impact.

## Team

Wiliams Lopes: solo builder, Head of Events at De Vinci Blockchain, ESILV Paris. LinkedIn: https://www.linkedin.com/in/wilivms/

---

## Video script (under 2:00)

Final cut, 1:42: https://youtu.be/ld7dE8nHTlI. The script below was the plan; the cut adds Recoil (wait or act) and the bot redemption on testnet.

(0:00–0:12, slide "The problem") On Mezo mainnet, 1,279 positions were hit by redemptions and only 28 by liquidations. Leveraged troves are first in line. Coil is leverage built for that.

(0:12–0:20, the app, wallet connected) This is Coil on Mezo testnet. I open 0.02 BTC at 3x.

(0:20–0:35, click Coil, sign, confirm) One signature, one transaction: a flash swap from Mezo's own pool opens the trove in my name. Before, by hand, that was 25 transactions.

(0:35–0:55, Guard panel, "Test it now") Guard is a signed stop-loss. Every swap is bounded by MUSD's own price feed, which fixes the Wave 1 finding. I press "Test it now": the keeper fires it within seconds. Here it is in the activity list, and on the explorer.

(0:55–1:20, Reserve and Shield panel) Redemptions are the real risk. I put MUSD in the Reserve: it sits in Mezo's sMUSD vault and earns yield. The Shield watches the redemption queue on-chain, and when too little debt stands before me, it repays from the Reserve. It only repays, so it works in Recovery Mode too.

(1:20–1:40, Proof page) Everything is on the Proof page: the verified contract, the first transaction of every flow, and the tests behind each claim, including fork tests against the live Mezo contracts.

(1:40–1:55, slide "Every point of the review, answered") Every point of the Wave 1 review is answered.

(1:55–2:00, close slide) Coil. Your Bitcoin, wound tight.

---

## Mezo Discord post (Wave 2 progress)

Coil, Wave 2 update 🧡 Leverage on Mezo that survives redemptions.
- CoilRouter v4 is live on testnet, source-verified, owned by a 24 h timelock. Every swap is bounded by MUSD's PriceFeed.
- New: Reserve (MUSD in sMUSD) and Shield, a signed repay that fires when your trove nears the front of the redemption queue. It works in Recovery Mode.
- Guard and Shield work on ANY MUSD trove, even one opened in the Mezo app. An always-on keeper fires them within about 15 s.
Try it in 2 minutes: https://coil-mezo-blitz-bet.vercel.app/#/try
Demo (1:42): https://youtu.be/ld7dE8nHTlI
Feedback welcome, especially on the redemption-queue trigger.
