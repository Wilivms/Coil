# Coil test report (Wave 2, CoilRouter v4)

Run everything: `cd contracts && forge test` (CI profile: `FOUNDRY_PROFILE=ci`, deep profile: `FOUNDRY_PROFILE=deep`).

## Suites

| Suite | Tests | What it covers |
|---|---|---|
| `CoilRouter.t.sol` | 54 | Every flow: coil, unwind, deleverage, relever, Guard, Reserve, Shield, Recoil, incentives; sandwiches, oracle deviation, pending redistribution, Recovery Mode |
| `CoilEdges.t.sol` | 20 | Adversarial and edge paths: a keeper re-entering from its BTC bounty hits the lock, constructor rejections, ownership transfer, expired and missing orders, slippage floors, Recoil bounty larger than its surplus, incentives capped by the refund |
| `CoilOwnTolerance.t.sol` | 9 | v4: a borrower's own PriceFeed tolerance opens, levers and closes at a 5.8% pool gap; the default still refuses; the choice never leaks into the next call; a keeper-fired Guard stays on 3% |
| `CoilTimelock.t.sol` | 6 | The owner is a 24 h OpenZeppelin timelock: the old owner is locked out, nothing runs early, only proposers schedule, the delay can't be shortened, cancel works, hard caps still bind |
| `invariant/CoilInvariant.t.sol` | 7 | Random sequences of 20 actions, incl. v4 trades with a random own tolerance up to 20% (flows, pool attacks, redistributions, Recovery Mode, Recoil cycles). Router never keeps BTC or loose MUSD, never owns a trove, Reserve always backed, lock always released |
| `SignatureCompat.t.sol` | 4 | The app's viem EIP-712 digests equal MUSD's |
| `fork/CoilFork.t.sol` | 6 | Real Mezo testnet contracts: real oracle gap, real sMUSD, real redemption queue, real Refinance + Adjust signatures, real gauge |
| `fork/CoilMainnetFork.t.sol` | 3 | Real Mezo **mainnet** contracts: Reserve in mainnet sMUSD + Shield repaying a mainnet trove, the mainnet redemption queue, and a coil on the shallow mainnet pool refused by the oracle bound |

**116 tests (107 unit/fuzz/invariant + 9 fork on testnet and mainnet), all green.**

## Pushing the limits

- **Deep profile** (`FOUNDRY_PROFILE=deep`): 10,000 runs per fuzz test, 512 invariant runs × depth 300 (≈150k random calls per invariant): 65/65 pass.
- **Coverage** (`forge coverage --ir-minimum`, unit + edge tests): CoilRouter v4 **97.1% lines, 95.9% statements, 82.1% branches, 100% functions**; CoilLens 100% lines; CoilTimelock 100%. Remaining branches are defensive (`_takeFromReserve` over-delivery, unreachable once `harvest` runs first) or need a pool that lies about its reserves.

## Static analysis (Slither)

Re-run on v4 + CoilTimelock (11 Nov 2026, 61 results, 76 detectors): no real finding. CoilTimelock is OpenZeppelin's TimelockController unchanged. Triage:

| Detector | Verdict |
|---|---|
| reentrancy-no-eth / reentrancy-benign | Every external entry point sits under the single flow lock (R10); the only external calls mid-flow go to MUSD, the pool and sMUSD (trusted dependencies). `test_reentrancyFromBountyHitsLock` re-enters from the keeper bounty and gets `Busy` |
| incorrect-equality | `== 0` checks on balances and amounts, intended |
| uninitialized-local | Locals set in every branch before use |
| unused-return | Pool `swap` and sMUSD returns that Coil re-reads from balances |
| calls-loop | The redemption-queue walk, bounded by `MAX_QUEUE_STEPS = 200` |
| timestamp | Signature and order deadlines; a few seconds of validator drift is irrelevant at hour/day scales |
| missing-zero-check (constructor `_treasury`) | Deployment-time parameter, set to a real address; `setTreasury` rejects zero afterwards and is behind the 24 h timelock |
| unused-return (`approve`) | MUSD returns true or reverts; `pushIncentives` only approves the exact amount for the gauge it then calls |
