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
- **Video:** [to add, under 2:00]
- **Contracts:** CoilRouter v3 `0x7b3D480207A95Ff14Ec89a0B9dA4dD435c4B6Ac4`, CoilLens `0x6ba3E71e7c4E5FF4Ba8962fdE12Ffe0a90323353` (both verified); v2 `0xa9ad…7a92` holds the first keeper-fired Guard

## TL;DR

Track 1 · Mezo testnet · Wave 1 project extended in Wave 2 · testnet deployment.
Coil opens a leveraged MUSD trove in one transaction, in the user's own name, then keeps it alive: Guard deleverages it before liquidation, and Shield repays it from a Reserve held in Mezo's sMUSD vault when the trove nears the front of the redemption queue or when MUSD enters Recovery Mode.

## Updates in this Wave (paste into "Updates in this Wave", 3,000 characters max)

Wave 2 answers every point of the Wave 1 review, and turns Coil from a leverage tool into leverage that survives Mezo's real risk.

The problem, measured on mainnet: MUSD's TroveManager logged 1,176 redemptions against 28 liquidations, 5.9M MUSD redeemed, 78.9 BTC taken from troves; 3 troves remain open. Leveraged troves sit at the front of the redemption queue.

What shipped (CoilRouter v2, 0xa9ad…7a92, source-verified):
- High finding fixed: every swap (coil, unwind, deleverage, Guard) is bounded by MUSD's PriceFeed (3% tolerance for MUSD trading under $1, 5% hard cap), and Guard stores a signed minBtcOut. A test replays the keeper sandwich and it reverts.
- Reserve: MUSD parked in Mezo's sMUSD vault through Coil, yield credited pro rata, only its owner can withdraw.
- Shield: a signed RepayMUSD funded by the Reserve. Fires at a price, or when less than X MUSD of debt stands ahead in the redemption queue, proved on-chain by walking SortedTroves (troves under MCR skipped). Repay-only, so it works in Recovery Mode where Guard can't.
- Always-on keeper: a GitHub Action polls every 15 s and chains itself; first Guard fired on-chain (tx 0x76ce…2894).
- Guard works on any MUSD trove, not only Coil's. "Test it now" buttons arm a Guard or Shield at today's price so anyone can watch the keeper fire.
- Fixed: pending redistribution was double-counted (contract and app). One-click claim of leftover BTC after a redemption. Recovery Mode and minimum debt read on-chain.
- App: Proof page (every flow with its tx), Try-it onboarding for outside testers, wallet counter, no forced intro.
- Security: threat model with each rule mapped to a test; 85 unit/fuzz/invariant/edge tests (random flows incl. pool attacks, 96.9% line coverage); 6 fork tests on live testnet (real sMUSD, a Shield repaying a real trove with a real RepayMUSD signature, the 350-trove queue); CI on every push.
- Why not mainnet: the mainnet BTC/MUSD pool holds ~0.75 BTC, so a 0.1 BTC 3x position would pay ~37% over mid. Coil launches there once the pool is deep; routing part of the fee to its gauge is the plan.

Business: 0.10% opening fee (capped 0.5% on-chain), keeper bounties, and every Coil trove pays MUSD interest that flows to sMUSD savers through MUSD's PCV.

## How it works

The user signs one EIP-712 message. CoilRouter flash-borrows BTC from Mezo's MUSD/BTC pool, opens the trove in the user's name through `openTroveWithSignature`, and repays the pool with the MUSD the trove minted. Unwind and deleverage run the same path in reverse. Guard stores a signed partial deleverage with a trigger and a minimum BTC out; Shield stores a signed repayment funded by the Reserve. The keeper executes either when its condition holds, and the contract re-checks the condition itself.

## Target group

BTC holders who borrow MUSD or want leveraged BTC without selling, intermediate to advanced DeFi users, desktop and mobile web, worldwide. Also any existing MUSD borrower: Guard and Shield work on troves opened in the Mezo app.

## Tech stack

Solidity 0.8.24, Foundry (unit, fuzz, invariant and fork tests), EIP-712, Mezo Pools flash swaps, MUSD BorrowerOperationsSignatures, TroveManager, SortedTroves, PriceFeed, MUSDSavingsRate. React, Vite, wagmi, viem, RainbowKit. viem keeper on GitHub Actions. Blockscout for indexed history.

## Future milestones

1. Dec 2026: re-coil a trove back to its target leverage after a redemption; Shield ladders.
2. Q1 2027: external audit, owner behind a timelock, fee routed to the BTC/MUSD gauge.
3. 2027: mainnet once the BTC/MUSD pool can take positions without double-digit impact.

## Team

Wiliams Lopes: solo builder, Head of Events at De Vinci Blockchain, ESILV Paris. LinkedIn: https://www.linkedin.com/in/wilivms/

---

## Video script (under 2:00)

(0:00–0:12, slide "The problem") On Mezo mainnet, 1,176 positions were hit by redemptions and only 28 by liquidations. Leveraged troves are first in line. Coil is leverage built for that.

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
- CoilRouter v2 is live on testnet and source-verified. Every swap is bounded by MUSD's PriceFeed.
- New: Reserve (MUSD in sMUSD) and Shield, a signed repay that fires when your trove nears the front of the redemption queue. It works in Recovery Mode.
- Guard and Shield work on ANY MUSD trove, even one opened in the Mezo app. An always-on keeper fires them within about 15 s.
Try it in 2 minutes: https://coil-mezo-blitz-bet.vercel.app/#/try
Feedback welcome, especially on the redemption-queue trigger.
