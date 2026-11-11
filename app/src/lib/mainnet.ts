import { useQuery } from '@tanstack/react-query'
import { createPublicClient, defineChain, http, parseAbi, type Address } from 'viem'

/** Mezo MAINNET, read-only. Coil is not deployed there; this only reads MUSD's own state. */
const mezoMainnet = defineChain({
  id: 31612, name: 'Mezo', nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://mezo-mainnet.boar.network'] } },
})
const main = createPublicClient({ chain: mezoMainnet, transport: http(undefined, { batch: true }) })

const M = {
  troveManager: '0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193',
  priceFeed: '0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88',
  sortedTroves: '0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f',
  pool: '0x52e604c44417233b6CcEDDDc0d640A405Caacefb',
  musd: '0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186',
} as const

const abi = parseAbi([
  'function fetchPrice() view returns (uint256)', // not view on-chain; eth_call is fine
  'function getLast() view returns (address)',
  'function getPrev(address) view returns (address)',
  'function getSize() view returns (uint256)',
  'function getCurrentICR(address, uint256) view returns (uint256)',
  'function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingColl, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getReserves() view returns (uint256, uint256, uint256)',
  'function token0() view returns (address)',
  'function totalSupply() view returns (uint256)',
])

export type MainnetTrove = { owner: Address; icr: number; debt: number; coll: number; redeemable: boolean; ahead: number }
export type MainnetQueue = { price: number; troves: MainnetTrove[]; poolBtc: number; poolMusd: number; supply: number; block: bigint }

const ZERO = '0x0000000000000000000000000000000000000000'

export async function fetchMainnetQueue(max = 25): Promise<MainnetQueue> {
  const [price, last, r, t0, supply, block] = await Promise.all([
    main.readContract({ address: M.priceFeed, abi, functionName: 'fetchPrice' }),
    main.readContract({ address: M.sortedTroves, abi, functionName: 'getLast' }),
    main.readContract({ address: M.pool, abi, functionName: 'getReserves' }),
    main.readContract({ address: M.pool, abi, functionName: 'token0' }),
    main.readContract({ address: M.musd, abi, functionName: 'totalSupply' }),
    main.getBlockNumber(),
  ])
  // walk from the tail: MUSD redeems the lowest-ratio troves first, skipping those under 110%
  const owners: Address[] = []
  let cur = last as Address
  while (cur && cur !== ZERO && owners.length < max) {
    owners.push(cur)
    cur = (await main.readContract({ address: M.sortedTroves, abi, functionName: 'getPrev', args: [cur] })) as Address
  }
  const rows = await Promise.all(owners.map(async (o) => {
    const [icr, d] = await Promise.all([
      main.readContract({ address: M.troveManager, abi, functionName: 'getCurrentICR', args: [o, price as bigint] }),
      main.readContract({ address: M.troveManager, abi, functionName: 'getEntireDebtAndColl', args: [o] }),
    ])
    return { owner: o, icr: Number(icr) / 1e18, debt: Number(d[1] + d[2]) / 1e18, coll: Number(d[0]) / 1e18 }
  }))
  let ahead = 0
  const troves = rows.map((x) => {
    const redeemable = x.icr >= 1.1
    const row = { ...x, redeemable, ahead }
    if (redeemable) ahead += x.debt
    return row
  })
  const musdIs0 = (t0 as string).toLowerCase() === M.musd.toLowerCase()
  return {
    price: Number(price) / 1e18, troves,
    poolMusd: Number(musdIs0 ? r[0] : r[1]) / 1e18, poolBtc: Number(musdIs0 ? r[1] : r[0]) / 1e18,
    supply: Number(supply) / 1e18, block,
  }
}

export function useMainnetQueue() {
  return useQuery({ queryKey: ['mainnet-queue'], queryFn: () => fetchMainnetQueue(), refetchInterval: 120_000, retry: 1 })
}
