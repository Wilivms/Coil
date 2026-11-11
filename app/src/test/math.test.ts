import { describe, expect, it } from 'vitest'
import { amountIn, fromWad, GAS_COMP, maxLeverage, planClose, planGuard, planOpen, planShield, releverPlan, SAFE_OPEN_CR, type Market } from '../lib/math'

const e18 = 10n ** 18n
// testnet-like pool: 1,300 BTC / 104M MUSD (mid 80,000), oracle 80,000, 0.04% fee
const m: Market = { price: 80_000n * e18, reserveMusd: 104_000_000n * e18, reserveBtc: 1_300n * e18, feeBps: 4n, minNetDebt: 1800n * e18, interestBps: 100 }

describe('amountIn (constant product with fee)', () => {
  it('k never decreases after the swap', () => {
    for (const out of [e18 / 100n, e18, 50n * e18]) {
      const inn = amountIn(out, m.reserveMusd, m.reserveBtc, m.feeBps)
      // the pool (Velodrome-style) deducts fee = amountIn * fee / 10_000, rounded down
      const effIn = inn - (inn * m.feeBps) / 10_000n
      expect((m.reserveMusd + effIn) * (m.reserveBtc - out)).toBeGreaterThanOrEqual(m.reserveMusd * m.reserveBtc)
    }
  })
  it('costs more than the mid price, more so for size', () => {
    const small = fromWad(amountIn(e18 / 10n, m.reserveMusd, m.reserveBtc, m.feeBps)) * 10
    const big = fromWad(amountIn(100n * e18, m.reserveMusd, m.reserveBtc, m.feeBps)) / 100
    expect(small).toBeGreaterThan(80_000)
    expect(big).toBeGreaterThan(small)
  })
  it('refuses to drain the pool', () => {
    expect(() => amountIn(m.reserveBtc, m.reserveMusd, m.reserveBtc, m.feeBps)).toThrow()
  })
})

describe('planOpen', () => {
  it('a 3x plan on 0.05 BTC is ok, covers the pool and refunds the buffer', () => {
    const p = planOpen(m, e18 / 20n, 3)
    expect(p.status).toBe('ok')
    expect(p.totalColl).toBe((e18 / 20n) * 3n)
    expect(p.flashBtc).toBe(p.totalColl - p.deposit)
    expect(p.debtAmount).toBeGreaterThan(p.musdIn)
    expect(p.refund).toBe(p.debtAmount - p.musdIn)
    expect(p.compositeDebt).toBe(p.debtAmount + p.borrowFee + GAS_COMP)
    expect(p.icr).toBeGreaterThan(SAFE_OPEN_CR)
    expect(p.liqPrice).toBeLessThan(80_000)
  })
  it('flags debt under the 1,800 MUSD minimum', () => {
    expect(planOpen(m, e18 / 1000n, 1.5).status).toBe('below-min-debt')
  })
  it('flags a plan that would open too tight', () => {
    expect(['tight', 'below-mcr']).toContain(planOpen(m, e18, 9).status)
  })
  it('maxLeverage stays at or above the safe ratio', () => {
    const lev = maxLeverage(m, e18 / 10n)
    expect(planOpen(m, e18 / 10n, lev).icr).toBeGreaterThanOrEqual(SAFE_OPEN_CR - 1e-9)
    expect(planOpen(m, e18 / 10n, lev + 0.1).icr).toBeLessThan(SAFE_OPEN_CR)
  })
})

describe('planClose / planGuard / planShield / releverPlan', () => {
  const t = { coll: 3n * e18, debt: 160_000n * e18, status: 1, interestBps: 100 }
  it('closing sells just enough BTC and returns the rest', () => {
    const c = planClose(m, t)
    expect(c.ok).toBe(true)
    expect(c.btcOut + c.btcToPool).toBe(t.coll)
    expect(c.musdOwed).toBe(t.debt - GAS_COMP + 10n ** 15n)
  })
  it('a Guard lands on its target ratio and asks for a non-zero minBtcOut', () => {
    const g = planGuard(m, t, 65_000, 1.6)
    expect(g.ok).toBe(true)
    expect(g.crAfter).toBeGreaterThan(1.5)
    expect(g.minBtcOut).toBeGreaterThan(0n)
    expect(g.debtAfter).toBeGreaterThanOrEqual(2000)
  })
  it('a Guard below the liquidation price is refused', () => {
    expect(planGuard(m, t, 50_000, 1.6).ok).toBe(false)
  })
  it('a Shield on a trove at the debt floor has nothing to repay and says so (never a 0-MUSD order)', () => {
    const s = planShield({ ...t, debt: 2_000_600n * 10n ** 15n }, 0.25, 70_000)
    expect(s.ok).toBe(false)
    expect(s.repay).toBe(0n)
    expect(s.reason).toMatch(/nothing to repay/)
  })
  it('a Shield never repays under the minimum debt', () => {
    const s = planShield({ ...t, debt: 2_100n * e18 }, 0.5, 70_000)
    expect(s.debtAfter).toBeGreaterThanOrEqual(2000)
  })
  it('leverage up adds collateral and debt and stays above the safe ratio', () => {
    const low = { coll: 3n * e18, debt: 100_000n * e18 } // 1.71x
    const r = releverPlan(m, low, 2.4)
    expect(r.ok).toBe(true)
    expect(r.addColl).toBeGreaterThan(0n)
    expect(r.crAfter).toBeGreaterThanOrEqual(SAFE_OPEN_CR)
    expect(releverPlan(m, low, 1.2).ok).toBe(false) // already above
  })
})
