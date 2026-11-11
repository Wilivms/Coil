import { amountIn, BORROW_FEE_WAD, fromWad, type Market } from './math'

/** What a trade costs against MUSD's oracle, line by line, in MUSD. Positive = you pay; negative = in your favour. */
export type CostRow = { label: string; musd: number; hint?: string }

export type CostExtras = { coilFeeBps?: number; incentiveBps?: number; borrowed?: bigint; deposit?: bigint }

function poolLines(m: Market, paidValue: number, fairValue: number, midValue: number, feeValue: number): CostRow[] {
  const gap = midValue - fairValue // the pool's mid vs the oracle, at this size
  const fee = feeValue
  const impact = paidValue - midValue - fee
  return [
    { label: 'Pool vs oracle gap', musd: gap, hint: "where the pool's mid sits against MUSD's PriceFeed" },
    { label: `Pool fee (${(Number(m.feeBps) / 100).toFixed(2)}%)`, musd: fee },
    { label: 'Price impact', musd: impact, hint: 'your own size moving the pool' },
  ]
}

/** Buying `btc` from the pool with MUSD: coil, leverage up, Recoil. */
export function buyBtcCosts(m: Market, btc: bigint, x: CostExtras = {}): CostRow[] {
  if (btc <= 0n) return []
  let musdIn: bigint
  try { musdIn = amountIn(btc, m.reserveMusd, m.reserveBtc, m.feeBps) } catch { return [] }
  const p = fromWad(m.price)
  const b = fromWad(btc)
  const mid = fromWad(m.reserveMusd) / fromWad(m.reserveBtc)
  const paid = fromWad(musdIn)
  const rows = poolLines(m, paid, b * p, b * mid, paid * (Number(m.feeBps) / 10_000))
  if (x.borrowed) rows.push({ label: 'MUSD borrowing fee (0.10%)', musd: fromWad((x.borrowed * BORROW_FEE_WAD) / 10n ** 18n) })
  if (x.deposit && x.coilFeeBps) rows.push({ label: `Coil fee (${(x.coilFeeBps / 100).toFixed(2)}% of the deposit)`, musd: fromWad(x.deposit) * p * (x.coilFeeBps / 10_000) })
  if (x.borrowed && x.incentiveBps) rows.push({ label: `To the MUSD/BTC gauge (${(x.incentiveBps / 100).toFixed(2)}%)`, musd: fromWad(x.borrowed) * (x.incentiveBps / 10_000), hint: 'taken from the refunded buffer' })
  return rows
}

/** Selling BTC to the pool for `musd`: unwind, deleverage, Guard. */
export function sellBtcCosts(m: Market, musd: bigint): CostRow[] {
  if (musd <= 0n) return []
  let btcIn: bigint
  try { btcIn = amountIn(musd, m.reserveBtc, m.reserveMusd, m.feeBps) } catch { return [] }
  const p = fromWad(m.price)
  const mid = fromWad(m.reserveMusd) / fromWad(m.reserveBtc)
  const out = fromWad(musd)
  // value given, at the oracle, for `out` MUSD; at the mid it would have taken out/mid BTC
  const paid = fromWad(btcIn) * p
  const atMid = (out / mid) * p
  return poolLines(m, paid, out, atMid, paid * (Number(m.feeBps) / 10_000))
}

export const totalCost = (rows: CostRow[]) => rows.reduce((s, r) => s + r.musd, 0)
