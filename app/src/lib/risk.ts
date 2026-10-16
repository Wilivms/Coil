/** Risk engine: first-passage probabilities, Monte Carlo paths, realized vol and history replays. */

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-(x * x) / 2)
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

/**
 * Probability that a GBM price starting at s0 touches `barrier` (< s0) within `years`.
 * dS/S = mu dt + sigma dW. Closed form for the running minimum of a drifted Brownian motion.
 */
export function touchProbability(s0: number, barrier: number, sigma: number, years: number, mu = 0): number {
  if (barrier <= 0) return 0
  if (barrier >= s0) return 1
  if (years <= 0 || sigma <= 0) return 0
  const nu = mu - (sigma * sigma) / 2
  const b = Math.log(barrier / s0)
  const sd = sigma * Math.sqrt(years)
  const p = normCdf((b - nu * years) / sd) + Math.exp((2 * nu * b) / (sigma * sigma)) * normCdf((b + nu * years) / sd)
  return Math.min(1, Math.max(0, p))
}

/** Small deterministic PRNG so the Monte Carlo fan is stable between renders. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rand: () => number) {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

export type Paths = { paths: Float32Array[]; days: number; breached: Uint8Array; breachDay: Int16Array }

/** Daily GBM paths with a liquidation barrier. */
export function simulate(s0: number, sigma: number, days: number, n: number, barrier: number, seed = 7): Paths {
  const rand = mulberry32(seed)
  const dt = 1 / 365
  const drift = -(sigma * sigma) / 2 * dt
  const vol = sigma * Math.sqrt(dt)
  const paths: Float32Array[] = []
  const breached = new Uint8Array(n)
  const breachDay = new Int16Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const p = new Float32Array(days + 1)
    let s = s0
    p[0] = s
    for (let d = 1; d <= days; d++) {
      s *= Math.exp(drift + vol * gaussian(rand))
      p[d] = s
      if (!breached[i] && s <= barrier) {
        breached[i] = 1
        breachDay[i] = d
      }
    }
    paths.push(p)
  }
  return { paths, days, breached, breachDay }
}

/** Annualized realized volatility over the last `window` observations spaced `stepDays` apart. */
export function realizedVol(closes: number[], window = 30, stepDays = 1): number {
  const xs = closes.slice(-window - 1)
  if (xs.length < 3) return 0.55
  const r: number[] = []
  for (let i = 1; i < xs.length; i++) r.push(Math.log(xs[i] / xs[i - 1]))
  const mean = r.reduce((a, b) => a + b, 0) / r.length
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)
  return Math.sqrt((v * 365) / stepDays)
}

/**
 * Empirical liquidation rate: across every start day in history, how often did BTC fall by at least
 * `drawdown` (1 - liqPrice/price) within `horizon` days? Model-free counterpart to touchProbability.
 */
export function historicalTouchRate(closes: number[], drawdown: number, horizon: number, step = 1): number {
  if (drawdown <= 0) return 1
  const n = closes.length
  let hits = 0
  let total = 0
  for (let i = 0; i + horizon < n; i += step) {
    const floor = closes[i] * (1 - drawdown)
    let hit = false
    for (let j = i + 1; j <= i + horizon; j++) {
      if (closes[j] <= floor) {
        hit = true
        break
      }
    }
    if (hit) hits++
    total++
  }
  return total ? hits / total : 0
}

export type Replay = {
  equity: number[] // position equity, in BTC
  hold: number[] // simply holding the deposit, in BTC
  liquidatedAt: number | null
  minCr: number
}

/**
 * Replay a Coil position from `start` through the given closes.
 * Collateral C = deposit * leverage, debt in MUSD fixed at open (plus simple interest).
 * Equity in BTC = C - debt / price; liquidated once C * price / debt < 110%.
 */
export function replay(closes: number[], leverage: number, interestBps: number, stepDays = 1): Replay {
  const p0 = closes[0]
  const C = leverage
  // Unit deposit of 1 BTC. 0.6% covers the pool fee, the 0.1% borrow fee and typical impact;
  // the 200 MUSD gas reserve is ignored (negligible at this size).
  const debt0 = (leverage - 1) * p0 * 1.006
  const equity: number[] = []
  const hold: number[] = []
  let liquidatedAt: number | null = null
  let minCr = Infinity
  for (let i = 0; i < closes.length; i++) {
    const p = closes[i]
    const debt = debt0 * (1 + (interestBps / 10_000) * ((i * stepDays) / 365))
    const cr = (C * p) / debt
    minCr = Math.min(minCr, cr)
    if (liquidatedAt === null && cr < 1.1) liquidatedAt = i
    equity.push(liquidatedAt === null ? C - debt / p : 0)
    hold.push(1)
  }
  return { equity, hold, liquidatedAt, minCr }
}
