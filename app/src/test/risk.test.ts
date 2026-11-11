import { describe, expect, it } from 'vitest'
import { normCdf, realizedVol, touchProbability } from '../lib/risk'

describe('risk', () => {
  it('normCdf is a CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6)
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normCdf(-8)).toBeLessThan(1e-6)
  })
  it('touch probability rises with volatility and with the barrier', () => {
    expect(touchProbability(100, 70, 0.8, 1)).toBeGreaterThan(touchProbability(100, 70, 0.4, 1))
    expect(touchProbability(100, 90, 0.5, 1)).toBeGreaterThan(touchProbability(100, 70, 0.5, 1))
    expect(touchProbability(100, 101, 0.5, 1)).toBe(1)
  })
  it('realized vol of a flat series is 0', () => {
    expect(realizedVol(Array(40).fill(100), 30, 1)).toBe(0)
  })
})
