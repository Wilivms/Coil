# Findings and fixes (Wave 2 review)

Every issue found on Coil since Wave 1, by the Wave 1 judges, by our own tests and by running the product on-chain,
with its severity, how it was found and the fix. Severities follow the usual scale: High = user funds at risk,
Medium = a feature stops working or funds can be stuck, Low = wrong information or wasted gas, Info = hardening.

| # | Severity | Finding | Found by | Fix | Proof |
|---|---|---|---|---|---|
| 1 | **High** | A keeper could move the MUSD/BTC pool before `fireGuard` and sell the user's collateral cheap (sandwich) | Wave 1 judges | Every swap bounded by MUSD's PriceFeed (`maxDeviationBps`, 3%, hard cap 5%) + signed `minBtcOut` on Guard | `test_guard_keeperSandwichReverts`, `testFuzz_guardNeverSellsBelowOracleBound`, invariants with pool attacks |
| 2 | **Medium** | Guard can't withdraw collateral in Recovery Mode, so protection stopped exactly when it matters | Wave 1 judges | Shield: a signed repay-only order funded by an sMUSD Reserve | `test_shield_worksInRecoveryMode` |
| 3 | **Medium** | The testnet pool drifted 5.5–6.8% from the oracle, past the 5% owner cap: every coil and leverage-up reverted, for everyone | Our on-chain E2E (10 Nov) | v4: the borrower may accept a wider gap (≤ 20%) on a trade they send; keeper flows stay on 3% | `CoilOwnTolerance.t.sol`, invariants `coilOwn/unwindOwn/releverOwn`, [v4 E2E at the gap](../e2e-testnet.md) |
| 4 | **Medium** | Owner actions (fee, tolerance, treasury, incentives) were immediate single-key calls | Self-review | Owner is a 24 h OpenZeppelin `TimelockController`, no admin role, anyone executes | `CoilTimelock.t.sol`, [timelock on the explorer](https://explorer.test.mezo.org/address/0x1e565FFC7400EbC7652839C2E49EFa0BD3179D33) |
| 5 | Low | Pending redistribution added twice to the debt (contract `closeAmount` and app) | Wave 1 reviews (raised on several projects) | Read MUSD's `getEntireDebtAndColl` totals once | `test_closeAmount_doesNotDoubleCountPending` |
| 6 | Low | BTC left in `CollSurplusPool` after a redemption closed a trove had no way out in the app | Wave 1 reviews | One-click `claimCollateral` banner | app |
| 7 | Low | A hintless `fireShield` used 4.7M gas; the RPC estimated 32,742, so a keeper tx could run out of gas | Our on-chain E2E | Keeper, script and app's fire button pass SortedTroves insert hints; gas floor and 9.5M cap | [hinted E2E](../e2e-testnet.md) |
| 8 | Low | A leverage-up succeeded on-chain but the app showed "failed" (the RPC answered "method handler crashed" to the receipt poll) | UI E2E (`app/e2e/ui-e2e.mjs`) | Confirmations retry through transient RPC errors; never report a failure we can't see | [UI E2E](../e2e-testnet.md) |
| 9 | Low | "Fire it yourself" racing the keeper showed a raw revert | UI E2E | Explains that it was already fired | app |
| 9b | Low | Mezo's RPC fails gas estimation now and then: a wallet shows an error on a valid transaction | UI E2E (`FLOW=protect`) | The app estimates gas itself with retries and passes the limit to the wallet | [UI E2E](../e2e-testnet.md) |
| 9c | Low | A Shield bigger than the Reserve could be armed with only a status pill to say it can't fire | Edge-case run (`FLOW=queue`) | Warning before signing, with the MUSD missing | [edge cases](../e2e-testnet.md) |
| 9d | Low | On a trove close to MUSD's 2,000 debt floor, the app planned a 0-MUSD Shield and let you sign it; the contract rejected it | Filming the demo | No Shield when there's under 10 MUSD of headroom, with the reason shown; unit test | `math.test.ts` |
| 10 | Info | Constructor doesn't zero-check `_treasury` | Slither | Deployment parameter, set; `setTreasury` rejects zero and is behind the timelock | [Slither triage](testing.md) |
| 11 | Info | A keeper's BTC bounty is a native call: could it re-enter? | Self-review | Single flow lock across every entry point | `test_reentrancyFromBountyHitsLock` |

## Accepted

- **One signed protection fires at a time.** Guard, Shield and Recoil sign at the same MUSD nonce; the first that fires
  makes the others stale. The app shows it and asks to sign again.
- **Inside the tolerance**, a sandwich can still take up to the bound minus fees; the user's signed amounts narrow it.
- **Not audited.** Testnet only. External audit before any mainnet use.
