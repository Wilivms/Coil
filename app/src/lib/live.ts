import { useQuery } from '@tanstack/react-query'
import { createPublicClient, http, type Address } from 'viem'
import { ADDR, COIL_LENS, COIL_ROUTER, mezoTestnet, ROUTER_V2 } from './chain'
import {
  borrowerOpsAbi, bosAbi, coilLensAbi, coilRouterAbi, collSurplusAbi, erc20Abi, interestRateManagerAbi, poolAbi, poolFactoryAbi,
  priceFeedAbi, troveManagerAbi,
} from './abis'
import { GAS_COMP, type Market, type Trove } from './math'
import { BTC_WEEKLY, BTC_WEEKLY_STEP } from '../data/btcWeekly'

/** Batched JSON-RPC client: concurrent reads collapse into one HTTP request. */
export const client = createPublicClient({
  chain: mezoTestnet,
  transport: http(undefined, { batch: { batchSize: 512, wait: 16 } }),
})

export type MarketState = Market & {
  tcr: number
  recoveryMode: boolean
  troves: number
  block: bigint
  updatedAt: number
  /** CoilRouter settings, read live (both change only through the 24 h timelock) */
  coilFeeBps: number
  incentiveBps: number
}

export async function fetchMarket(): Promise<MarketState> {
  const [price, reserves, feeBps, minNetDebt, rate, troves, block] = await Promise.all([
    client.readContract({ address: ADDR.priceFeed, abi: priceFeedAbi, functionName: 'fetchPrice' }),
    client.readContract({ address: ADDR.pool, abi: poolAbi, functionName: 'getReserves' }),
    client.readContract({ address: ADDR.poolFactory, abi: poolFactoryAbi, functionName: 'getFee', args: [ADDR.pool, false] }),
    client.readContract({ address: ADDR.borrowerOps, abi: borrowerOpsAbi, functionName: 'minNetDebt' }),
    client.readContract({ address: ADDR.interestRateManager, abi: interestRateManagerAbi, functionName: 'interestRate' }),
    client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getTroveOwnersCount' }),
    client.getBlockNumber(),
  ])
  const [tcr, recoveryMode, coilFeeBps, incentiveBps] = await Promise.all([
    client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getTCR', args: [price] }),
    client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'checkRecoveryMode', args: [price] }),
    COIL_ROUTER ? client.readContract({ address: COIL_ROUTER, abi: coilRouterAbi, functionName: 'feeBps' }) : Promise.resolve(0),
    COIL_ROUTER ? client.readContract({ address: COIL_ROUTER, abi: coilRouterAbi, functionName: 'incentiveBps' }) : Promise.resolve(0),
  ])
  return {
    price,
    reserveMusd: reserves[0], // token0 = MUSD on testnet
    reserveBtc: reserves[1],
    feeBps,
    minNetDebt,
    interestBps: Number(rate),
    tcr: Number(tcr) / 1e18,
    coilFeeBps: Number(coilFeeBps),
    incentiveBps: Number(incentiveBps),
    recoveryMode,
    troves: Number(troves),
    block,
    updatedAt: Date.now(),
  }
}

export function useMarket() {
  return useQuery({ queryKey: ['market'], queryFn: fetchMarket, refetchInterval: 15_000, staleTime: 10_000 })
}

export type TroveState = Trove & { nonce: bigint; exists: boolean }

export async function fetchTrove(user: Address): Promise<TroveState> {
  const [dc, status, rate, nonce] = await Promise.all([
    client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl', args: [user] }),
    client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getTroveStatus', args: [user] }),
    client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getTroveInterestRate', args: [user] }),
    client.readContract({ address: ADDR.borrowerOpsSignatures, abi: bosAbi, functionName: 'getNonce', args: [user] }),
  ])
  // MUSD's getEntireDebtAndColl already folds pending redistributions into coll, principal and
  // interest (the pending fields are reported for information only): adding them again double counts.
  const [coll, principal, interest] = dc
  return {
    coll,
    debt: principal + interest,
    status: Number(status),
    interestBps: Number(rate),
    nonce,
    exists: Number(status) === 1,
  }
}

export function useTrove(user?: Address) {
  return useQuery({
    queryKey: ['trove', user],
    queryFn: () => fetchTrove(user as Address),
    enabled: !!user,
    refetchInterval: 15_000,
  })
}

export type GuardState = {
  armed: boolean
  fresh: boolean
  triggered: boolean
  recoveryMode: boolean
  triggerPrice: bigint
  collWithdrawal: bigint
  debtRepay: bigint
  minBtcOut: bigint
  deadline: bigint
  bountyBps: number
}

export function useGuard(user?: Address) {
  return useQuery({
    queryKey: ['guard', user],
    enabled: !!user && !!COIL_ROUTER,
    refetchInterval: 20_000,
    queryFn: async (): Promise<GuardState> => {
      const [g, s] = await Promise.all([
        client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'guardOf', args: [user!] }),
        client.readContract({ address: COIL_LENS, abi: coilLensAbi, functionName: 'guardStatus', args: [user!] }),
      ])
      return {
        armed: s[0], fresh: s[1], triggered: s[2], recoveryMode: s[3], triggerPrice: g.triggerPrice,
        collWithdrawal: g.collWithdrawal, debtRepay: g.debtRepay, minBtcOut: g.minBtcOut, deadline: g.deadline,
        bountyBps: g.bountyBps,
      }
    },
  })
}

/* ------------------------------------------------------------------ reserve and shield */

export type ReserveState = {
  reserve: bigint // MUSD in the Coil Reserve (sMUSD), yield included
  legacy: bigint // MUSD still in the v2 router's Reserve, to move over
  wallet: bigint // MUSD in the wallet
  allowance: bigint
  totalReserve: bigint
}

export function useReserve(user?: Address) {
  return useQuery({
    queryKey: ['reserve', user],
    enabled: !!user && !!COIL_ROUTER,
    refetchInterval: 20_000,
    queryFn: async (): Promise<ReserveState> => {
      const [reserve, wallet, allowance, totalReserve, legacy] = await Promise.all([
        client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'reserveBalance', args: [user!] }),
        client.readContract({ address: ADDR.musd, abi: erc20Abi, functionName: 'balanceOf', args: [user!] }),
        client.readContract({ address: ADDR.musd, abi: erc20Abi, functionName: 'allowance', args: [user!, COIL_ROUTER!] }),
        client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'totalReserve' }),
        COIL_ROUTER!.toLowerCase() === ROUTER_V2.toLowerCase()
          ? Promise.resolve(0n)
          : client.readContract({ address: ROUTER_V2, abi: coilRouterAbi, functionName: 'reserveBalance', args: [user!] }).catch(() => 0n),
      ])
      return { reserve, wallet, allowance, totalReserve, legacy }
    },
  })
}

export type ShieldState = {
  armed: boolean
  fresh: boolean
  funded: boolean
  byPrice: boolean
  byQueue: boolean
  ahead: bigint // redeemable MUSD ahead of the trove in the queue
  found: boolean
  repayAmount: bigint
  triggerPrice: bigint
  maxDebtAhead: bigint
  bountyMusd: bigint
  deadline: bigint
}

/** How far the keeper and the app walk the redemption queue (the contract caps it at 200). */
export const QUEUE_STEPS = 200n

export function useShield(user?: Address) {
  return useQuery({
    queryKey: ['shield', user],
    enabled: !!user && !!COIL_ROUTER,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ShieldState> => {
      const [sh, st, da] = await Promise.all([
        client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'shieldOf', args: [user!] }),
        client.readContract({ address: COIL_LENS, abi: coilLensAbi, functionName: 'shieldStatus', args: [user!, QUEUE_STEPS] }),
        client.readContract({ address: COIL_LENS, abi: coilLensAbi, functionName: 'debtAhead', args: [user!, QUEUE_STEPS] }),
      ])
      return {
        armed: st[0], fresh: st[1], funded: st[2], byPrice: st[3], byQueue: st[4], ahead: da[0], found: da[1],
        repayAmount: sh.repayAmount, triggerPrice: sh.triggerPrice, maxDebtAhead: sh.maxDebtAhead,
        bountyMusd: sh.bountyMusd, deadline: sh.deadline,
      }
    },
  })
}

export type RecoilState = {
  armed: boolean
  fresh: boolean
  triggered: boolean
  icr: number
  capacity: bigint // MUSD still borrowable under MUSD's borrowing capacity
  triggerIcr: number
  addColl: bigint
  debtIncrease: bigint
}

export function useRecoil(user?: Address) {
  return useQuery({
    queryKey: ['recoil', user],
    enabled: !!user && !!COIL_ROUTER,
    refetchInterval: 20_000,
    queryFn: async (): Promise<RecoilState> => {
      const [st, r] = await Promise.all([
        client.readContract({ address: COIL_LENS, abi: coilLensAbi, functionName: 'recoilStatus', args: [user!] }),
        client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'recoilOf', args: [user!] }),
      ])
      return {
        armed: st[0], fresh: st[1], triggered: st[2], icr: Number(st[3]) / 1e18, capacity: st[4],
        triggerIcr: Number(r.triggerIcr) / 1e18, addColl: r.addColl, debtIncrease: r.debtIncrease,
      }
    },
  })
}

/** BTC left in MUSD's CollSurplusPool after a redemption or a Recovery Mode liquidation closed the trove. */
export function useSurplus(user?: Address) {
  return useQuery({
    queryKey: ['surplus', user],
    enabled: !!user,
    refetchInterval: 60_000,
    queryFn: () =>
      client.readContract({ address: ADDR.collSurplusPool, abi: collSurplusAbi, functionName: 'getCollateral', args: [user!] }),
  })
}

/* ------------------------------------------------------------------ redemption radar */

export type RadarTrove = { owner: Address; coll: number; debt: number; cr: number }
export type Radar = { troves: RadarTrove[]; price: number; fetchedAt: number }

/** Every active trove with its ratio, read in two batched rounds (owners, then debt and collateral). */
export async function fetchRadar(price: bigint): Promise<Radar> {
  const count = Number(
    await client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getTroveOwnersCount' }),
  )
  const owners = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      client.readContract({
        address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getTroveFromTroveOwnersArray', args: [BigInt(i)],
      }),
    ),
  )
  const rows = await Promise.all(
    owners.map((o) =>
      client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl', args: [o] }),
    ),
  )
  const p = Number(price) / 1e18
  const troves = rows
    .map((r, i) => {
      const coll = Number(r[0]) / 1e18 // pending already included
      const debt = Number(r[1] + r[2]) / 1e18
      return { owner: owners[i], coll, debt, cr: debt > 0 ? (coll * p) / debt : Infinity }
    })
    .filter((t) => t.debt > 0)
    .sort((a, b) => a.cr - b.cr)
  return { troves, price: p, fetchedAt: Date.now() }
}

export function useRadar(price?: bigint) {
  return useQuery({
    queryKey: ['radar', price ? Math.round(Number(price) / 1e20) : 0],
    queryFn: () => fetchRadar(price!),
    enabled: !!price,
    staleTime: 60_000,
    refetchInterval: 90_000,
  })
}

/**
 * Redemptions hit the lowest ratios first (troves under 110% are skipped: they are liquidatable).
 * Returns the MUSD that has to be redeemed before a trove at `cr` is touched, and its rank.
 */
export function redemptionShield(r: Radar, cr: number, self?: Address) {
  let ahead = 0
  let rank = 1
  let eligible = 0
  for (const t of r.troves) {
    if (self && t.owner.toLowerCase() === self.toLowerCase()) continue
    if (t.cr < 1.1) continue
    eligible++
    if (t.cr < cr) {
      ahead += Math.max(0, t.debt - Number(GAS_COMP) / 1e18)
      rank++
    }
  }
  return { musdAhead: ahead, rank, of: eligible + 1 }
}

/* ------------------------------------------------------------------ BTC history */

export type History = { closes: number[]; stepDays: number; source: 'binance' | 'snapshot'; startDay: number }

async function fetchBinanceDaily(): Promise<History> {
  const hosts = ['https://api.binance.com', 'https://data-api.binance.vision']
  for (const host of hosts) {
    try {
      const closes: number[] = []
      let start = Date.UTC(2019, 0, 1)
      let firstDay = 0
      for (let page = 0; page < 4; page++) {
        const res = await fetch(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${start}&limit=1000`)
        if (!res.ok) throw new Error(String(res.status))
        const rows: [number, string, string, string, string][] = await res.json()
        if (!rows.length) break
        if (page === 0) firstDay = Math.round(rows[0][0] / 86_400_000)
        rows.forEach((k) => closes.push(Number(k[4])))
        start = rows[rows.length - 1][0] + 86_400_000
        if (rows.length < 1000) break
      }
      if (closes.length > 365) return { closes, stepDays: 1, source: 'binance', startDay: firstDay }
    } catch {
      /* try the next host */
    }
  }
  return { closes: BTC_WEEKLY, stepDays: BTC_WEEKLY_STEP, source: 'snapshot', startDay: 17897 }
}

export function useBtcHistory() {
  return useQuery({ queryKey: ['btc-history'], queryFn: fetchBinanceDaily, staleTime: 3_600_000, retry: 0 })
}
