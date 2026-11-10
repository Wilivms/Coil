import type { Address } from 'viem'
import { ADDR, COIL_ROUTER } from './chain'
import { coilRouterAbi, priceFeedAbi } from './abis'
import { client } from './live'

/** CoilRouter v4 bounds every swap by MUSD's PriceFeed. Keeper-fired flows always use the owner's
 *  default (3%, hard cap 5%). On a trade the borrower sends themselves, they may accept a wider gap
 *  for that one call (up to 20%), so a pool that drifted from the oracle can never block opening,
 *  levering up or closing. The app sets it from the live quote, plus a margin for the block in between. */
export const DEFAULT_DEVIATION_BPS = 300
export const MAX_OWN_DEVIATION_BPS = 2000
const MARGIN_BPS = 75

/** Tolerance (bps) to send for a trade that pays `paidUsd` for `fairUsd` of value at the oracle. 0 = default is enough. */
export function toleranceFor(paidUsd: bigint, fairUsd: bigint): number {
  if (fairUsd <= 0n) return 0
  const gapBps = Number(((paidUsd - fairUsd) * 10_000n) / fairUsd)
  const need = gapBps + MARGIN_BPS
  if (need <= DEFAULT_DEVIATION_BPS) return 0
  return Math.min(Math.ceil(need / 25) * 25, MAX_OWN_DEVIATION_BPS)
}

const price = () => client.readContract({ address: ADDR.priceFeed, abi: priceFeedAbi, functionName: 'fetchPrice' })

/** Buying `btc` from the pool with MUSD (coil, leverage up). */
export async function buyBtcTolerance(btc: bigint): Promise<number> {
  if (btc === 0n) return 0
  const [p, musdIn] = await Promise.all([
    price(),
    client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'quoteMusdForBtc', args: [btc] }),
  ])
  return toleranceFor(musdIn, (btc * p) / 10n ** 18n)
}

/** Selling BTC to the pool for `musd` (unwind, deleverage). */
export async function sellBtcTolerance(musd: bigint): Promise<number> {
  if (musd === 0n) return 0
  const [p, btcIn] = await Promise.all([
    price(),
    client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'quoteBtcForMusd', args: [musd] }),
  ])
  return toleranceFor((btcIn * p) / 10n ** 18n, musd)
}

export async function unwindTolerance(user: Address): Promise<number> {
  const owed = await client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'closeAmount', args: [user] })
  return sellBtcTolerance(owed)
}

/** For display: how far the pool mid sits from the oracle (+ = BTC dearer in the pool). */
export function poolGap(reserveMusd: bigint, reserveBtc: bigint, oracle: bigint): number {
  if (reserveBtc === 0n || oracle === 0n) return 0
  return Number((reserveMusd * 10n ** 18n * 10_000n) / reserveBtc / oracle) / 10_000 - 1
}
