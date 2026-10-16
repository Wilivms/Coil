/**
 * Coil maths. Everything that touches the chain is bigint (18 decimals) and mirrors CoilRouter.sol;
 * the risk side works in floats.
 */

export const WAD = 10n ** 18n
export const GAS_COMP = 200n * WAD
export const BORROW_FEE_WAD = 10n ** 15n // 0.1%
export const MCR = 1.1
export const SAFE_OPEN_CR = 1.15 // the UI refuses plans below this after price impact

export const toWad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n
export const fromWad = (x: bigint) => Number(x) / 1e18

/** Exact-out input on the volatile curve, identical to CoilRouter._amountIn. */
export function amountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountOut >= reserveOut) throw new Error('Not enough liquidity in the pool')
  return (reserveIn * amountOut * 10_000n) / ((reserveOut - amountOut) * (10_000n - feeBps)) + 1n
}

export type Market = {
  price: bigint // MUSD price feed, BTC/USD 18d
  reserveMusd: bigint
  reserveBtc: bigint
  feeBps: bigint
  minNetDebt: bigint
  interestBps: number
}

export type OpenPlan = {
  deposit: bigint
  leverage: number
  totalColl: bigint
  flashBtc: bigint
  musdIn: bigint
  debtAmount: bigint
  refund: bigint
  borrowFee: bigint
  compositeDebt: bigint
  icr: number
  liqPrice: number
  poolPrice: number // effective MUSD per BTC paid on the flash
  priceImpact: number // vs the pool's mid price
  interestYear: number // MUSD
  status: 'ok' | 'tight' | 'below-mcr' | 'below-min-debt' | 'no-liquidity' | 'empty'
}

/** Plan a one-transaction open: deposit * leverage of collateral, flash the difference. */
export function planOpen(m: Market, deposit: bigint, leverage: number, slippage = 0.005): OpenPlan {
  const base: OpenPlan = {
    deposit, leverage, totalColl: 0n, flashBtc: 0n, musdIn: 0n, debtAmount: 0n, refund: 0n, borrowFee: 0n,
    compositeDebt: 0n, icr: Infinity, liqPrice: 0, poolPrice: 0, priceImpact: 0, interestYear: 0, status: 'empty',
  }
  if (deposit <= 0n || leverage <= 1) return base
  const totalColl = (deposit * BigInt(Math.round(leverage * 10_000))) / 10_000n
  const flashBtc = totalColl - deposit
  let musdIn: bigint
  try {
    musdIn = amountIn(flashBtc, m.reserveMusd, m.reserveBtc, m.feeBps)
  } catch {
    return { ...base, totalColl, flashBtc, status: 'no-liquidity' }
  }
  const debtAmount = (musdIn * BigInt(Math.round((1 + slippage) * 10_000))) / 10_000n
  const borrowFee = (debtAmount * BORROW_FEE_WAD) / WAD
  const compositeDebt = debtAmount + borrowFee + GAS_COMP
  const price = fromWad(m.price)
  const icr = (fromWad(totalColl) * price) / fromWad(compositeDebt)
  const liqPrice = (MCR * fromWad(compositeDebt)) / fromWad(totalColl)
  const mid = fromWad(m.reserveMusd) / fromWad(m.reserveBtc)
  const poolPrice = fromWad(musdIn) / fromWad(flashBtc)
  let status: OpenPlan['status'] = 'ok'
  if (debtAmount + borrowFee < m.minNetDebt) status = 'below-min-debt'
  else if (icr < MCR) status = 'below-mcr'
  else if (icr < SAFE_OPEN_CR) status = 'tight'
  return {
    deposit, leverage, totalColl, flashBtc, musdIn, debtAmount, refund: debtAmount - musdIn, borrowFee,
    compositeDebt, icr, liqPrice, poolPrice, priceImpact: poolPrice / mid - 1,
    interestYear: (fromWad(compositeDebt) * m.interestBps) / 10_000, status,
  }
}

/** Highest leverage whose plan stays at or above `minCr` (bisection on the real quote). */
export function maxLeverage(m: Market, deposit: bigint, minCr = SAFE_OPEN_CR): number {
  if (deposit <= 0n) return 1
  let lo = 1.01, hi = 15
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const p = planOpen(m, deposit, mid)
    if (p.status !== 'no-liquidity' && p.icr >= minCr) lo = mid
    else hi = mid
  }
  return lo
}

export type Trove = {
  coll: bigint
  debt: bigint // principal + interest + pending, incl. the 200 MUSD gas compensation
  status: number
  interestBps: number
}

export type ClosePlan = { musdOwed: bigint; btcToPool: bigint; btcOut: bigint; ok: boolean }

export function planClose(m: Market, t: Trove): ClosePlan {
  const musdOwed = t.debt - GAS_COMP + 10n ** 15n
  try {
    const btcToPool = amountIn(musdOwed, m.reserveBtc, m.reserveMusd, m.feeBps)
    return { musdOwed, btcToPool, btcOut: t.coll - btcToPool, ok: t.coll > btcToPool }
  } catch {
    return { musdOwed, btcToPool: 0n, btcOut: 0n, ok: false }
  }
}

export type GuardPlan = {
  trigger: number
  repay: bigint
  withdraw: bigint
  crAtTrigger: number
  crAfter: number
  debtAfter: number
  ok: boolean
  reason?: string
}

/**
 * Size a Guard: at `trigger`, repay just enough MUSD that the trove lands on `targetCr`.
 * The BTC withdrawn to pay the flash is sized at the trigger price with a 3% margin; anything
 * the pool does not need comes back to the user, so over-withdrawing is harmless.
 */
export function planGuard(m: Market, t: Trove, trigger: number, targetCr = 1.6, minNetDebt = 1800): GuardPlan {
  const C = fromWad(t.coll)
  const D = fromWad(t.debt)
  const fee = Number(m.feeBps) / 10_000
  const k = (1 + fee) * 1.03 // BTC per MUSD at trigger, with margin
  const crAtTrigger = (C * trigger) / D
  const R = (targetCr * D - C * trigger) / (targetCr - k)
  const base = { trigger, crAtTrigger, repay: 0n, withdraw: 0n, crAfter: crAtTrigger, debtAfter: D }
  if (!(trigger > 0)) return { ...base, ok: false, reason: 'Pick a trigger price' }
  if (R <= 0) return { ...base, ok: false, reason: `Your ratio is still above ${Math.round(targetCr * 100)}% at that price` }
  const maxRepay = D - (minNetDebt + 200)
  const repay = Math.min(R, maxRepay)
  if (repay <= 0) return { ...base, ok: false, reason: 'Debt is already at the 1,800 MUSD minimum' }
  const withdraw = (repay / trigger) * k
  const crAfter = ((C - withdraw) * trigger) / (D - repay)
  if (crAtTrigger < MCR) return { ...base, ok: false, reason: 'That trigger is below your liquidation price' }
  return {
    trigger, crAtTrigger, crAfter, debtAfter: D - repay, ok: true,
    repay: toWad(repay), withdraw: toWad(withdraw),
  }
}

/** Value of the position in BTC terms if closed at oracle price `p` (ignores pool impact). */
export const equityUsd = (collBtc: number, debt: number, p: number) => collBtc * p - debt
