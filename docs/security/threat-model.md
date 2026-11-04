# Coil threat model

Scope: `contracts/src/CoilRouter.sol` (v3, Wave 2) and `CoilLens.sol` (read-only), the app's signing code (`app/src/lib/signing.ts`) and the keeper (`keeper/guard-keeper.mjs`).
Each rule below names the test that enforces it. Run them all with `cd contracts && forge test` (fork tests: add `--match-path "test/fork/*" --fork-url https://rpc.test.mezo.org`).

## What Coil holds, and what it never holds

| Asset | Where it lives | Who can move it |
|---|---|---|
| The trove (BTC collateral, MUSD debt) | MUSD's own contracts, in the **user's** name | The user, or Coil only with an exact EIP-712 signature from the user |
| BTC during a coil, unwind or deleverage | CoilRouter, for the length of one transaction | Nobody after the transaction: the router ends every flow with 0 BTC |
| Gauge incentives (MUSD) | CoilRouter, until anyone calls `pushIncentives` | Only the MUSD/BTC gauge incentive contract set by the owner (share capped at 0.20% of a coil's debt) |
| Reserve MUSD | Mezo's sMUSD vault, held by CoilRouter, credited per user | The user (`withdrawReserve`), or the user's own signed Shield, only to repay the user's own trove |
| Signed Guard / Shield / Recoil | CoilRouter storage | A keeper can execute it only when the on-chain condition holds; the user can delete it any time |

Coil has **no** forwarder or meta-transaction path, **no** proxy or upgrade, **no** admin function that can touch a trove, a signature or the Reserve. The October 5, 2026 veBTC exploit came through a meta-transaction forwarder; there is nothing equivalent here (`grep -rn "forwarder\|_msgSender\|delegatecall" contracts/src` only matches the NatSpec line that says so).

## Actors

- **User**: signs typed data in the app; owns the trove.
- **Keeper**: anyone. Calls `fireGuard` / `fireShield` for a bounty. Assumed hostile: may sandwich, reorder, or fire at the worst moment it can.
- **Pool traders / MEV**: can move the MUSD/BTC pool price before and after any Coil transaction.
- **Owner**: can set the fee (hard cap 0.50%), the oracle tolerance (hard cap 5%) and the treasury. Assumed honest but limited by code.
- **Mezo**: MUSD (BorrowerOperationsSignatures, TroveManager, SortedTroves, PriceFeed), the MUSD/BTC pool and sMUSD are trusted dependencies.

## Rules

### R1. A swap never prices more than `maxDeviationBps` away from MUSD's PriceFeed
Every flash swap compares the USD value paid with the USD value received at the PriceFeed price and reverts with `PriceDeviation` beyond the tolerance (default 3%, hard cap 5%). This is the fix for the Wave 1 High finding: a keeper could previously move the pool and fire a Guard so the user's collateral sold cheap.
- `test_guard_keeperSandwichReverts`, `test_coil_sandwichedPoolReverts`, `test_unwind_sandwichedPoolReverts`
- `testFuzz_guardNeverSellsBelowOracleBound` (any dump size)
- `invariant_*` with the `attackPool` action (pool moved without the oracle)

Why not 0%: MUSD trades under $1 (≈$0.99 on mainnet, the testnet pool prices BTC ≈2% above the oracle), so BTC bought with MUSD always looks ≈2% dear. `test_coil_toleratesMusdDiscountWithinBound`, `test_fork_coilAtRealOracleGap` (live testnet gap), `test_coil_beyondToleranceReverts`, `test_coil_widenedToleranceWorksAgain`, `test_setMaxDeviation_bounds`.

### R2. A Guard returns at least the BTC its owner signed for
`armGuard` stores `minBtcOut`; `fireGuard` reverts with `Slippage` below it. Within the oracle tolerance, this is the user's own floor.
- `test_guard_respectsSignedMinBtcOut`, `test_guard_rejectsBadParams` (minBtcOut can't be 0)

### R3. A keeper can only fire what is due
Guard: PriceFeed at or below the trigger. Shield: price trigger, or the redemption-queue condition proved on-chain by walking `SortedTroves` from its tail (troves under MCR skipped, like MUSD's own redemption loop). If the walk can't reach the trove within `maxSteps`, the Shield does **not** fire.
- `test_guard_firesOnlyBelowTrigger`, `test_shield_priceTriggerRepaysFromReserve`, `test_shield_redemptionQueueTrigger`, `test_shield_queueSkipsTrovesUnderMcr`, `test_shield_queueNotProvenWithinStepsDoesNotFire`, `test_fork_debtAheadOnRealQueue` (live 350+ trove queue)

### R4. Signatures do exactly one thing, once
Coil never builds a signature; MUSD's BorrowerOperationsSignatures verifies borrower, amounts, recipient, nonce and deadline. Any other signed trove operation bumps the nonce and makes a stored Guard/Shield stale; status views report it.
- `test_coil_revertsOnWrongSigner`, `test_guard_staleAfterOtherTroveOp`, `test_shield_staleAfterSignedOp`
- `SignatureCompat.t.sol`: the app's viem digests equal MUSD's for OpenTrove, AdjustTrove, CloseTrove and RepayMUSD

### R5. Coil never ends a transaction holding BTC, and holds MUSD only for the gauge
BTC is accepted only mid-flow (`receive()` reverts otherwise), so a signature replayed straight against MUSD with Coil as recipient can't strand funds.
- `test_signatureUsedDirectlyCannotStrandBtc`, `test_reserve_rejectsBtc`
- `invariant_routerHoldsNoBtc`, `invariant_routerHoldsOnlyPendingIncentives` (MUSD balance == pending incentives)

### R6. Coil never owns a trove
- `test_coil_opensTroveOwnedByUser`, `invariant_routerOwnsNoTrove`

### R7. The Reserve is always fully backed and only its owner can take it out
sMUSD held by Coil ≥ the sum of every user's Reserve, yield included; rounding dust (in the vault's favour) stays below 0.000001 MUSD.
- `invariant_reserveIsBacked`, `invariant_totalReserveMatchesSum`, `testFuzz_reserveAccounting`
- `test_reserve_onlyOwnerCanWithdraw`, `test_reserve_yieldSplitsProRata`, `test_reserve_withdrawAllIncludesYield`
- `test_fork_reserveAndShieldOnRealMezo` (real sMUSD, real RepayMUSD signature, real trove)

### R8. Protection still works in Recovery Mode
In Recovery Mode MUSD forbids collateral withdrawals, so a Guard can't fire (status reports it). A Shield only repays, which MUSD allows.
- `test_guard_blockedInRecoveryMode_statusSaysSo`, `test_shield_worksInRecoveryMode`

### R9. Debt is read once
MUSD's `getEntireDebtAndColl` already folds pending redistributions into `coll`, `principal` and `interest`. Coil (contract and app) uses those totals and never adds the pending fields again.
- `test_closeAmount_doesNotDoubleCountPending`

### R10. One flow at a time
A single lock covers coil, unwind, deleverage, Guard, Reserve and Shield; the pool callback only runs inside a Coil-initiated swap.
- `test_hookOnlyFromPoolDuringFlow`, `invariant_flowLockReleased`

### R11. Leverage goes up only as signed, within MUSD's capacity
Relever and Recoil add exactly the signed collateral and debt; every swap keeps the PriceFeed bound; MUSD enforces its borrowing capacity, which only a signed refinance (one nonce earlier, same transaction) can reset. A Recoil fires only when the trove's ratio is at or above its trigger.
- `test_relever_addsCollateralAndDebtInOneTx`, `test_relever_sandwichedPoolReverts`, `test_relever_blockedByShrunkCapacity`, `test_relever_withRefinanceResetsCapacity`
- `test_recoil_firesWhenRatioClimbsBack`, `test_recoil_restoresLeverageAfterRedemption`, `test_recoil_staleAfterSignedOp`, `test_recoil_rejectsBadParams`
- `test_fork_refinanceThenReleverOnRealMezo` (real Refinance + AdjustTrove signatures on consecutive nonces)

### R12. Incentives can only go to the gauge, capped
`incentiveBps` ≤ 20 (0.20% of debt), target set by the owner; `pushIncentives` is permissionless and only calls `notifyRewardAmount(MUSD, amount)` on that target.
- `test_incentives_accrueOnCoilAndPushToGauge`, `test_incentives_cappedAndOwnerOnly`, `test_fork_incentivesReachRealGauge`

## Known limits (accepted)

- **One signed protection fires at a time.** Guard, Shield and Recoil are signed at the same MUSD nonce, so the first one that fires makes the others stale. The app shows it and asks to sign again; the status views report `fresh = false`.

- **Tolerance window.** Inside the oracle tolerance, a sandwich can still take up to `maxDeviationBps` minus fees and impact. The user's own limits (`debtAmount` on coil, `minBtcOut` on unwind, deleverage and Guard) narrow it further.
- **Fixed-amount signatures.** MUSD signs exact amounts, so a Guard/Shield repays what was signed even if the trove changed through unsigned operations (interest, redistribution). Status views and the app show the sizes before arming.
- **Queue proof is bounded.** `MAX_QUEUE_STEPS = 200`. A trove deeper than that can't prove the redemption trigger; it is also far from redemption.
- **Dependencies.** Reserve funds inherit the risk of Mezo's sMUSD vault; prices inherit MUSD's PriceFeed (it reverts when older than 60 s, which makes Coil revert too).
- **Owner.** Can widen the tolerance to at most 5% and the fee to at most 0.50%. Planned: hand ownership to a timelock before any mainnet use.

## Not in scope of this file

Front-end supply chain (dependency audit runs in CI via `npm ci` lockfile), wallet security, MUSD's own correctness.
