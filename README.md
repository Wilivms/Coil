# Coil

**Leveraged Bitcoin on Mezo that survives redemptions.**

Coil opens a leveraged MUSD trove in one transaction, in the user's own name, and keeps it alive: **Guard** deleverages it before liquidation, and **Shield** repays it from a **Reserve** parked in Mezo's sMUSD vault when the trove gets close to the front of the redemption queue.

Track 1 (DeFi) · Chain: Mezo testnet (31611) · Status: Wave 1 project, extended in Wave 2 · Readiness: testnet deployment · [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10)

**App:** https://wilivms.github.io/Coil/#/app · **Threat model:** [`docs/security/threat-model.md`](docs/security/threat-model.md) · **CI:** [![CI](https://github.com/Wilivms/Coil/actions/workflows/ci.yml/badge.svg)](https://github.com/Wilivms/Coil/actions/workflows/ci.yml) · **Keeper runs:** [Actions → Keeper](https://github.com/Wilivms/Coil/actions/workflows/keeper.yml)

## Review in 5 minutes

1. **The problem, measured on Mezo** (`cd keeper && npm ci && npm run stats` reprints every number with its block):
   - On mainnet, MUSD's TroveManager has logged **1,176 redemptions against 28 liquidations**: 5.9M MUSD redeemed, 78.9 BTC taken from troves. Only **3 troves** are still open, for 29.5M MUSD in circulation.
   - Redemptions take the lowest-ratio troves first. A leveraged trove is exactly that, so for a Mezo borrower the risk that ends a position is a redemption, not a liquidation.
2. **The product:** one transaction to open at 1.5–4×, one to close. Guard covers the price, Shield covers redemptions and Recovery Mode, the Reserve earns sMUSD yield while it waits.
3. **The code:** [`contracts/src/CoilRouter.sol`](contracts/src/CoilRouter.sol), one immutable contract, no proxy, no forwarder, no admin path to user funds.
4. **The proof:** `cd contracts && forge test` (unit, fuzz, invariants) and the fork suite against the real Mezo testnet contracts (below).
5. **The security story:** [threat model](docs/security/threat-model.md), every rule mapped to the test that enforces it.

## What changed since Wave 1

Every sentence of the Wave 1 review, and what answers it:

| Wave 1 review | Wave 2 answer | Proof |
|---|---|---|
| "Fix the High finding first: add a signed minBtcOut or a PriceFeed-based bound to fireGuard so a keeper can't sandwich the pool" | **Both.** Every swap (coil, unwind, deleverage, Guard) is bounded by MUSD's PriceFeed (`maxDeviationBps`, 3% default, 5% hard cap), and Guard stores a signed `minBtcOut` | `test_guard_keeperSandwichReverts`, `testFuzz_guardNeverSellsBelowOracleBound`, invariants with pool attacks |
| "make it work in Recovery Mode (Guard can't withdraw collateral when TCR is under 150%)" | **Shield**: a signed `RepayMUSD` funded by the Reserve. Repaying is allowed in Recovery Mode | `test_shield_worksInRecoveryMode`, `test_guard_blockedInRecoveryMode_statusSaysSo` |
| "run the Guard stop-loss end to end on-chain with a keeper" | Keeper runs every 5 minutes on GitHub Actions and fires Guards and Shields; "Test it now" in the app arms a Guard that fires within minutes | [Keeper runs](https://github.com/Wilivms/Coil/actions/workflows/keeper.yml), fires in the activity panel |
| "get wallets other than your deployer using the router" | Guard and Shield now work on **any** MUSD trove, not only Coil's; onboarding for outside testers | `test_guard_worksOnTroveNotOpenedWithCoil` |
| "verify CoilRouter on the Mezo explorer" | v2 source-verified on Blockscout | link below |
| "Cut the demo video to 2 minutes, and let visitors reach the app without the drawing intro" | Video under 2:00; `#/app` opens the app directly | |
| Raised across many Wave 1 reviews: double-counted pending redistribution, redemptions, `claimCollateral` | `closeAmount` and the app read MUSD's totals once; Shield's redemption trigger; one-click claim of leftover BTC after a redemption | `test_closeAmount_doesNotDoubleCountPending` |

## Live on Mezo testnet

| | |
|---|---|
| CoilRouter v2 (Wave 2) | deploying, address added here once on-chain |
| CoilRouter v1 (Wave 1) | [`0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16`](https://explorer.test.mezo.org/address/0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16) |
| MUSD/BTC pool | [`0xd16A…6AA9`](https://explorer.test.mezo.org/address/0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9) (flash lender) |
| sMUSD vault | [`0x6f46…7e16`](https://explorer.test.mezo.org/address/0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16) (where the Reserve sits) |

## How it uses Mezo

| Mezo primitive | Coil uses it to |
|---|---|
| Mezo Pools flash swap (`Pool.swap` → `hook`) | borrow the BTC (open) or MUSD (close) for one transaction |
| `BorrowerOperationsSignatures` (Open, Close, Adjust, RepayMUSD) | act on the user's trove only with an exact EIP-712 signature: the trove is never Coil's |
| MUSD `PriceFeed` | trigger Guard and Shield, and bound every swap |
| `SortedTroves` + `TroveManager` | prove on-chain how much redeemable debt stands before a trove |
| sMUSD (`MUSDSavingsRate`) | hold the Reserve and earn its yield (MUSD borrower interest flows there through MUSD's PCV) |
| `CollSurplusPool` / `claimCollateral` | return leftover BTC after a redemption closes a trove |
| BTC native + ERC-20 precompile | forward pool BTC as collateral without wrapping |

## Features

| | What it does | Where |
|---|---|---|
| **Coil** | Open at a target leverage in one tx; leftover MUSD refunded | `coil` |
| **Unwind** | Close the whole trove in one tx, net BTC back | `unwind` |
| **Deleverage** | Repay part of the debt with a flash swap | `deleverage` |
| **Guard** | Signed partial deleverage + price trigger + `minBtcOut`; any keeper fires it for a BTC bounty; any MUSD trove | `armGuard` / `fireGuard` / `guardStatus` |
| **Reserve** | MUSD in Mezo's sMUSD vault, yield credited pro rata, only its owner can withdraw | `depositReserve` / `withdrawReserve` / `reserveBalance` |
| **Shield** | Signed repay from the Reserve, fired at a price or when ≤ X MUSD stands ahead in the redemption queue; works in Recovery Mode | `armShield` / `fireShield` / `shieldStatus` / `debtAhead` |
| **Claim** | Leftover BTC after a redemption, one click | `BorrowerOperations.claimCollateral` |
| **Risk cockpit** | Liquidation odds, Monte Carlo, history replay, live redemption radar | `app/src/lib/risk.ts`, `live.ts` |

## Why not mainnet yet

Mainnet's MUSD/BTC pool holds about 0.75 BTC. A 0.1 BTC position at 3× would pay roughly 37% over the pool's mid price there, against 0.3% on testnet (`npm run stats`). Coil would launch on mainnet only once that pool is deep enough; routing part of Coil's fee to the pool's gauge is the plan to help get it there.

## Repository

```
contracts/   Foundry: CoilRouter, Mezo interfaces, unit/fuzz/invariant/fork tests, deploy script
app/         Vite + React + wagmi/viem (landing + app)
keeper/      Guard and Shield keeper (viem), and the Mezo stats script
docs/        Threat model
```

## Tests

```bash
cd contracts
forge test                                                  # unit, fuzz, invariants (mocks mirror Mezo's pool and MUSD signatures)
forge test --match-path "test/fork/*" --fork-url https://rpc.test.mezo.org -vv   # the real Mezo testnet
```

- **Invariants** (`test/invariant/`): random sequences of coils, unwinds, deleverages, Guard and Shield fires, Reserve moves, yield, redistributions, Recovery Mode, market moves and pool attacks. The router never keeps BTC or loose MUSD, never owns a trove, and the Reserve stays fully backed.
- **Fork** (`test/fork/`): open and close a real trove; open at the live ~2% oracle gap; Reserve in the **real** sMUSD and a Shield repaying the **real** trove through a **real** `RepayMUSD` signature; walk the real 350-trove redemption queue.
- **Signatures** (`SignatureCompat.t.sol`): the app's viem digests equal MUSD's for all four signed operations.

## Deploy

```bash
cd contracts
cast wallet import coil-deployer --interactive    # once; the key stays encrypted on your machine
forge script script/Deploy.s.sol --rpc-url mezo_testnet --account coil-deployer --broadcast
```

## Keeper

```bash
cd keeper && npm ci
COIL_ROUTER=0x... KEEPER_PRIVATE_KEY=0x... npm start     # DRY_RUN=1 to watch only, ONCE=1 for a single pass
```

Unaudited hackathon code, testnet only.
