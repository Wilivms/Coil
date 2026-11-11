import { describe, expect, it } from 'vitest'
import { buyBtcCosts, sellBtcCosts, totalCost } from '../lib/costs'
import { amountIn, fromWad, type Market } from '../lib/math'
import { toleranceFor, poolGap, DEFAULT_DEVIATION_BPS, MAX_OWN_DEVIATION_BPS } from '../lib/tolerance'

const e18 = 10n ** 18n
const base = { reserveBtc: 1_300n * e18, feeBps: 4n, minNetDebt: 1800n * e18, interestBps: 100 }
const atPeg: Market = { ...base, price: 80_000n * e18, reserveMusd: 104_000_000n * e18 }
// pool prices BTC ~6% above the oracle, as testnet did on 10-11 Nov 2026
const dear: Market = { ...atPeg, price: 75_400n * e18 }

describe('cost against the oracle', () => {
  it('buy-side lines add up to what the pool takes over fair value', () => {
    const btc = e18 / 10n
    const rows = buyBtcCosts(dear, btc)
    const paid = fromWad(amountIn(btc, dear.reserveMusd, dear.reserveBtc, dear.feeBps))
    expect(totalCost(rows)).toBeCloseTo(paid - 0.1 * 75_400, 6)
    expect(rows.find((r) => r.label.startsWith('Pool vs oracle'))!.musd).toBeGreaterThan(0)
  })
  it('at the peg, the gap line is ~0 and only fee + impact remain', () => {
    const rows = buyBtcCosts(atPeg, e18 / 10n)
    expect(Math.abs(rows[0].musd)).toBeLessThan(1e-6)
    expect(totalCost(rows)).toBeGreaterThan(0)
  })
  it('selling BTC into a pool where it is dear works in your favour', () => {
    expect(totalCost(sellBtcCosts(dear, 5_000n * e18))).toBeLessThan(0)
  })
  it('extras: borrowing fee 0.10%, Coil fee on the deposit, gauge share', () => {
    const rows = buyBtcCosts(atPeg, e18 / 10n, { borrowed: 10_000n * e18, deposit: e18 / 20n, coilFeeBps: 10, incentiveBps: 5 })
    expect(rows.find((r) => r.label.startsWith('MUSD borrowing fee'))!.musd).toBeCloseTo(10, 6)
    expect(rows.find((r) => r.label.startsWith('Coil fee'))!.musd).toBeCloseTo(0.05 * 80_000 * 0.001, 6)
    expect(rows.find((r) => r.label.startsWith('To the MUSD/BTC gauge'))!.musd).toBeCloseTo(5, 6)
  })
})

describe('own tolerance (v4)', () => {
  it('0 when the default 3% is enough', () => {
    expect(toleranceFor(1010n, 1000n)).toBe(0)
  })
  it('covers the live gap plus a margin, rounded up to 0.25%', () => {
    const t = toleranceFor(1060n, 1000n) // 6% gap
    expect(t).toBeGreaterThan(600)
    expect(t % 25).toBe(0)
    expect(t).toBeGreaterThan(DEFAULT_DEVIATION_BPS)
  })
  it('never above the contract cap', () => {
    expect(toleranceFor(2000n, 1000n)).toBe(MAX_OWN_DEVIATION_BPS)
  })
  it('poolGap reads the pool mid against the oracle', () => {
    expect(poolGap(dear.reserveMusd, dear.reserveBtc, dear.price)).toBeCloseTo(80_000 / 75_400 - 1, 3)
  })
})
