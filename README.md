# Coil

**Leveraged Bitcoin on Mezo that survives redemptions.**

Coil opens a leveraged MUSD trove in one transaction, in the user's own name, and keeps it alive: **Guard** deleverages it before liquidation, **Shield** repays it from a **Reserve** parked in Mezo's sMUSD vault when the trove gets close to the front of the redemption queue, and **Recoil** levers it back to its target once BTC rises or a redemption shrinks the debt. A share of every coil goes to the MUSD/BTC gauge's incentives, deepening the pool Coil trades on.

Track 1 (DeFi) · Chain: Mezo testnet (31611) · Status: Wave 1 project, extended in Wave 2 · Readiness: testnet deployment · [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10)

**App:** https://coil-mezo-blitz-bet.vercel.app/#/app · **Proof:** [every transaction](https://coil-mezo-blitz-bet.vercel.app/#/proof) · **Try it in 2 minutes:** [#/try](https://coil-mezo-blitz-bet.vercel.app/#/try) · **Video (1:42):** [youtu.be/ld7dE8nHTlI](https://youtu.be/ld7dE8nHTlI) · **Deck:** [PDF](docs/Coil-deck.pdf) · **Threat model:** [`docs/security/threat-model.md`](docs/security/threat-model.md) · **CI:** [![CI](https://github.com/Wilivms/Coil/actions/workflows/ci.yml/badge.svg)](https://github.com/Wilivms/Coil/actions/workflows/ci.yml) · **Keeper runs:** [Actions → Keeper](https://github.com/Wilivms/Coil/actions/workflows/keeper.yml)

## Review in 5 minutes

1. **The problem, measured on Mezo** (`cd keeper && npm ci && npm run stats` reprints every number with its block):
   - On mainnet, MUSD's TroveManager has logged **1,279 redemptions against 28 liquidations**: 5.94M MUSD redeemed, 79.6 BTC taken from troves. Only **4 troves** are still open, for 19M MUSD in circulation (10 Nov 2026).
   - Redemptions take the lowest-ratio troves first. A leveraged trove is exactly that, so for a Mezo borrower the risk that ends a position is a redemption, not a liquidation.
2. **The product:** one transaction to open at 1.5–4×, one to lever up, one to close. Guard covers the price, Shield covers redemptions and Recovery Mode, Recoil restores leverage after them, the Reserve earns sMUSD yield while it waits.
3. **The code:** [`contracts/src/CoilRouter.sol`](contracts/src/CoilRouter.sol), one immutable contract (plus a read-only [`CoilLens`](contracts/src/CoilLens.sol)), no proxy, no forwarder, no admin path to user funds; its owner is a 24 h [timelock](contracts/src/CoilTimelock.sol).
4. **The proof:** `cd contracts && forge test` (unit, fuzz, invariants) and the fork suite against the real Mezo testnet contracts (below).
5. **The security story:** [threat model](docs/security/threat-model.md), every rule mapped to the test that enforces it; [findings and fixes](docs/security/findings.md), every issue found in Wave 2 with its severity.

## What changed since Wave 1

Every sentence of the Wave 1 review, and what answers it:

| Wave 1 review | Wave 2 answer | Proof |
|---|---|---|
| "Fix the High finding first: add a signed minBtcOut or a PriceFeed-based bound to fireGuard so a keeper can't sandwich the pool" | **Both.** Every swap (coil, unwind, deleverage, Guard) is bounded by MUSD's PriceFeed (`maxDeviationBps`, 3% default, 5% hard cap), and Guard stores a signed `minBtcOut` | `test_guard_keeperSandwichReverts`, `testFuzz_guardNeverSellsBelowOracleBound`, invariants with pool attacks |
| "make it work in Recovery Mode (Guard can't withdraw collateral when TCR is under 150%)" | **Shield**: a signed `RepayMUSD` funded by the Reserve. Repaying is allowed in Recovery Mode | `test_shield_worksInRecoveryMode`, `test_guard_blockedInRecoveryMode_statusSaysSo` |
| "run the Guard stop-loss end to end on-chain with a keeper" | Always-on keeper (GitHub Action polling every 15 s, chaining itself) fires Guards and Shields; "Test it now" arms one at today's price | First fire: [tx 0x76ce…2894](https://explorer.test.mezo.org/tx/0x76cefd312a3fab1e8d961aadbaea66c1f02f0e96209c5ab9969aa63ae17b2894) · [keeper runs](https://github.com/Wilivms/Coil/actions/workflows/keeper.yml) |
| "get wallets other than your deployer using the router" | Guard and Shield now work on **any** MUSD trove, not only Coil's; [Try-it onboarding](https://coil-mezo-blitz-bet.vercel.app/#/try) and a live wallet counter on the [Proof page](https://coil-mezo-blitz-bet.vercel.app/#/proof) | `test_guard_worksOnTroveNotOpenedWithCoil` · [3 outside wallets](docs/e2e-testnet.md): coil, keeper-fired Guard, Reserve, Shield, Recoil, unwind |
| "verify CoilRouter on the Mezo explorer" | v2 source-verified on Blockscout | [code tab](https://explorer.test.mezo.org/address/0xa9adbe2e3ddfbd3795add019c8ea64a950777a92#code) |
| "Cut the demo video to 2 minutes, and let visitors reach the app without the drawing intro" | Video under 2:00; the site opens straight, the intro is opt-in at `#/pitch` | [Demo, 1:42](https://youtu.be/ld7dE8nHTlI) |
| (found in Wave 2) the testnet pool drifted 5.5% from MUSD's oracle, past the 5% cap: every coil reverted | **v4**: a borrower may accept a wider gap (≤ 20%) on a trade they send, set from the live quote and shown before signing; Guard and Recoil stay on the 3% bound | `CoilOwnTolerance.t.sol`, [v4 E2E at the gap](docs/e2e-testnet.md) |
| Raised across many Wave 1 reviews: double-counted pending redistribution, redemptions, `claimCollateral` | `closeAmount` and the app read MUSD's totals once; Shield's redemption trigger; one-click claim of leftover BTC after a redemption | `test_closeAmount_doesNotDoubleCountPending` |

## Live on Mezo testnet

| | |
|---|---|
| CoilRouter v4 (Wave 2, current) | [`0x17e056ef7e076Fbcb806dF9916552A26Da527F03`](https://explorer.test.mezo.org/address/0x17e056ef7e076Fbcb806dF9916552A26Da527F03#code) · source-verified · [deploy tx](https://explorer.test.mezo.org/tx/0x801797876e6e12c531836bf4fa93bc4a04021bd3a648b71aa6d38d5c4ab5abb1) (block 16701916) |
| CoilTimelock (owner of v4, 24 h delay) | [`0x1e565FFC7400EbC7652839C2E49EFa0BD3179D33`](https://explorer.test.mezo.org/address/0x1e565FFC7400EbC7652839C2E49EFa0BD3179D33#code) · OpenZeppelin TimelockController, self-administered, anyone executes · first proposal, the 0.10% opening fee: [scheduled](https://explorer.test.mezo.org/tx/0x24f8364241596e901b97b4e2d83d1a7b3aa7ae2a5dc041d69713e07a8868c3d0), [executed 24 h later](https://explorer.test.mezo.org/tx/0x92fd9b15a536d3aed9e3964f75b59cf610191c487e73ad53cb52b2632fbd27c0) (`feeBps() = 10`); [first coil with the fee](https://explorer.test.mezo.org/tx/0x5659ce5811aea4c08c46a3aa0188a3449c9c6ca65fa59c16bf5126209852f03e) sent exactly 0.10% of the deposit to the treasury ([E2E](docs/e2e-testnet.md)) |
| CoilLens (status views) | [`0xa82154DD7bf08840F4D9d97a44999C4D4F76d8f5`](https://explorer.test.mezo.org/address/0xa82154DD7bf08840F4D9d97a44999C4D4F76d8f5#code) · source-verified |
| CoilRouter v3 (Wave 2) | [`0x7b3D480207A95Ff14Ec89a0B9dA4dD435c4B6Ac4`](https://explorer.test.mezo.org/address/0x7b3D480207A95Ff14Ec89a0B9dA4dD435c4B6Ac4#code) · source-verified · full on-chain E2E, keeper fired Shield, Recoil and Guard |
| CoilRouter v2 (Wave 2, first release) | [`0xa9adbe2e3ddfbd3795add019c8ea64a950777a92`](https://explorer.test.mezo.org/address/0xa9adbe2e3ddfbd3795add019c8ea64a950777a92) · source-verified · first keeper-fired Guard |
| CoilRouter v1 (Wave 1) | [`0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16`](https://explorer.test.mezo.org/address/0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16) |
| MUSD/BTC pool | [`0xd16A…6AA9`](https://explorer.test.mezo.org/address/0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9) (flash lender) |
| sMUSD vault | [`0x6f46…7e16`](https://explorer.test.mezo.org/address/0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16) (where the Reserve sits) |
| MUSD/BTC gauge incentives | [`0x75b6…0ee1`](https://explorer.test.mezo.org/address/0x75b6B35Fc78826A0B7E1f9c08bb7d84bd70D0ee1) (PoolsVoter `0x263F…5F0D`, receives 0.05% of each coil's debt) |

## How it uses Mezo

| Mezo primitive | Coil uses it to |
|---|---|
| Mezo Pools flash swap (`Pool.swap` → `hook`) | borrow the BTC (open) or MUSD (close) for one transaction |
| `BorrowerOperationsSignatures` (Open, Close, Adjust, RepayMUSD) | act on the user's trove only with an exact EIP-712 signature: the trove is never Coil's |
| MUSD `PriceFeed` | trigger Guard and Shield, and bound every swap |
| `SortedTroves` + `TroveManager` | prove on-chain how much redeemable debt stands before a trove |
| sMUSD (`MUSDSavingsRate`) | hold the Reserve and earn its yield (MUSD borrower interest flows there through MUSD's PCV) |
| `refinanceWithSignature` + `getTroveMaxBorrowingCapacity` | reset MUSD's borrowing capacity (it only ever shrinks) so a trove can lever up again |
| PoolsVoter gauge incentives (`notifyRewardAmount`) | pay veBTC voters to direct MEZO emissions to the MUSD/BTC pool |
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
| **Leverage up** | Flash BTC in and borrow the MUSD that pays for it, in one tx; adds a refinance signature when capacity is short | `relever` |
| **Recoil** | Signed leverage-up a keeper runs once the ratio is back above a trigger (BTC rose, or a redemption) | `armRecoil` / `fireRecoil` / `CoilLens.recoilStatus` |
| **Gauge incentives** | 0.05% of each coil's debt in MUSD, pushed by anyone to the MUSD/BTC gauge | `pushIncentives` |
| **Shield** | Signed repay from the Reserve, fired at a price or when ≤ X MUSD stands ahead in the redemption queue; works in Recovery Mode | `armShield` / `fireShield` / `shieldStatus` / `debtAhead` |
| **Claim** | Leftover BTC after a redemption, one click | `BorrowerOperations.claimCollateral` |
| **Risk cockpit** | Liquidation odds, Monte Carlo, history replay, live redemption radar | `app/src/lib/risk.ts`, `live.ts` |
| **Cost before you sign** | Every trade shows its cost against MUSD's oracle in MUSD: pool/oracle gap, pool fee, impact, MUSD's borrowing fee, Coil fee, gauge share | `app/src/lib/costs.ts` |
| **Wait or act** | When the pool sits past the 3% keeper bound, Recoil and Guard say why they wait and offer to do it now, with the gap and its cost | `RecoilPanel`, `GuardPanel` |
| **Fire it yourself** | Any due Guard, Shield or Recoil can be fired from the app by any wallet, for the bounty: no dependence on our keeper | `actions.fire` |
| **Read-only view** | `#/app?address=0x…` shows any wallet's trove, protections and history, no wallet needed | `AppPage` |
| **Keeper health + mainnet queue** | `/proof` reads the keeper's runs from GitHub Actions and Mezo mainnet's redemption queue live (read-only) | `keeperStatus.ts`, `mainnet.ts` |

## Why not mainnet yet

Mainnet's MUSD/BTC pool holds about 0.48 BTC (10 Nov 2026). A 0.1 BTC position at 3× would pay roughly 72% over the pool's mid price there, against 0.3% on testnet (`npm run stats`). Coil would launch on mainnet only once that pool is deep enough; that is why a share of every coil already goes to the pool's gauge incentives.

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
forge test --match-path "test/fork/CoilFork.t.sol" --fork-url mezo_testnet -vv          # the real Mezo testnet
forge test --match-path "test/fork/CoilMainnetFork.t.sol" --fork-url mezo_mainnet -vv   # the real Mezo mainnet (read-only)
```

- **Invariants** (`test/invariant/`): random sequences of coils, unwinds, deleverages, Guard and Shield fires, Reserve moves, yield, redistributions, Recovery Mode, market moves and pool attacks. The router never keeps BTC or loose MUSD, never owns a trove, and the Reserve stays fully backed.
- **Fork** (`test/fork/`): open and close a real trove; open at the live ~2% oracle gap; Reserve in the **real** sMUSD and a Shield repaying the **real** trove through a **real** `RepayMUSD` signature; walk the real 350-trove redemption queue; refinance + leverage up a real trove with two signatures in one tx; incentives landing in the **real** MUSD/BTC gauge contract.
- **On-chain end to end** ([`docs/e2e-testnet.md`](docs/e2e-testnet.md)): all 13 steps live on testnet, Shield, Recoil and Guard fired by the keeper on its own.
- **App** (`cd app && npm test`): 27 unit tests (EIP-712 digests equal MUSD's, pool math, plans, cost lines, own tolerance); and a UI end-to-end run on testnet through the live site with an injected test wallet ([`app/e2e/ui-e2e.mjs`](app/e2e/ui-e2e.mjs), results in [`docs/e2e-testnet.md`](docs/e2e-testnet.md)).
- **Report** ([`docs/security/testing.md`](docs/security/testing.md)): 91 tests, deep fuzz profile, 96.9% line coverage, Slither triage.
- **Mainnet fork** (`test/fork/CoilMainnetFork.t.sol`, `--fork-url mezo_mainnet`): Reserve in the **real mainnet** sMUSD and a Shield repaying a **real mainnet** trove; the mainnet redemption queue walked; and a coil on the shallow mainnet pool **refused** by the oracle bound (it would pay ~12% over fair for 0.05 BTC).
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
COIL_ROUTER=0x... COIL_LENS=0x... KEEPER_PRIVATE_KEY=0x... npm start     # DRY_RUN=1 to watch only, ONCE=1 for a single pass
```

Unaudited hackathon code, testnet only.
