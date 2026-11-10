import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, type Abi, type Address, type Hash, type Hex } from 'viem'
import { COIL_ROUTER, ROUTER_V1, ROUTER_V1_BLOCK, ROUTER_V2, ROUTER_V2_BLOCK, ROUTER_V3, ROUTER_V3_BLOCK, ROUTER_V4_BLOCK } from './chain'
import { routerEventsV1, routerEventsV2, routerEventsV3 } from './abis'
import { client } from './live'

/** v1 deployment transaction (Wave 1), still linked from the activity panel. */
export const DEPLOY_TX = '0x724a7b45f0fec9fbb97eb427b80ade4e076092db2d2b0e4004794532514c0118' as Hash

/** Mezo's public Blockscout indexer: the RPC caps eth_getLogs at 10,000 blocks, too slow for history. */
const BLOCKSCOUT = 'https://api.explorer.test.mezo.org/api/v2'

export type ActivityKind =
  | 'Coiled' | 'Unwound' | 'Delevered' | 'GuardArmed' | 'GuardDisarmed' | 'GuardFired'
  | 'ReserveDeposited' | 'ReserveWithdrawn' | 'ShieldArmed' | 'ShieldDisarmed' | 'ShieldFired'
  | 'Relevered' | 'RecoilArmed' | 'RecoilDisarmed' | 'RecoilFired' | 'IncentivesAccrued' | 'IncentivesPushed'

export type ActivityItem = {
  kind: ActivityKind
  user: Address
  tx: Hash
  block: bigint
  logIndex: number
  router: Router
  time?: number
  args: Record<string, bigint | Address | boolean>
}

type Router = 'v1' | 'v2' | 'v3' | 'v4'

export type Activity = { items: ActivityItem[]; wallets: number; walletsV2: number; total: number; fires: number }

type RawLog = { topics: Hex[]; data: Hex; block: bigint; tx: Hash; logIndex: number; time?: number }

function decode(raw: RawLog, abi: Abi, router: Router): ActivityItem | null {
  try {
    const topics = raw.topics.filter(Boolean) as [Hex, ...Hex[]]
    const d = decodeEventLog({ abi, topics, data: raw.data })
    const args = d.args as unknown as Record<string, bigint | Address | boolean>
    return {
      // IncentivesPushed has no user: it is listed under the gauge it paid
      kind: d.eventName as unknown as ActivityKind, user: (args.user ?? args.target) as Address, tx: raw.tx, block: raw.block,
      logIndex: raw.logIndex, router, time: raw.time, args,
    }
  } catch {
    return null // another event (fee, owner changes) or an unknown signature
  }
}

/** Every log of `address`, newest first, from Blockscout (raw topics + data, decoded here). */
async function indexedLogs(address: Address): Promise<RawLog[]> {
  const out: RawLog[] = []
  let url: string | null = `${BLOCKSCOUT}/addresses/${address}/logs`
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url)
    if (!res.ok) throw new Error(`Blockscout ${res.status}`)
    const j = await res.json()
    for (const it of j.items ?? []) {
      out.push({
        topics: it.topics, data: it.data, block: BigInt(it.block_number), tx: it.transaction_hash,
        logIndex: Number(it.index), time: it.block_timestamp ? Date.parse(it.block_timestamp) : undefined,
      })
    }
    const np = j.next_page_params as Record<string, string | number> | null
    url = np ? `${BLOCKSCOUT}/addresses/${address}/logs?${new URLSearchParams(Object.entries(np).map(([k, v]) => [k, String(v)]))}` : null
  }
  return out
}

/** The last ~10,000 blocks straight from the RPC: covers the indexer's lag, and stands in if it is down. */
async function recentLogs(address: Address, from: bigint): Promise<RawLog[]> {
  const head = await client.getBlockNumber()
  const start = head - 9_999n > from ? head - 9_999n : from
  const logs = await client.getLogs({ address, fromBlock: start, toBlock: head })
  return logs.map((l) => ({
    topics: l.topics as Hex[], data: l.data, block: l.blockNumber!, tx: l.transactionHash!, logIndex: l.logIndex!,
  }))
}

async function routerActivity(address: Address, abi: Abi, from: bigint, router: Router, live: boolean) {
  const [indexed, recent] = await Promise.all([
    indexedLogs(address).catch(() => [] as RawLog[]),
    live ? recentLogs(address, from).catch(() => [] as RawLog[]) : Promise.resolve([] as RawLog[]),
  ])
  const seen = new Set<string>()
  const items: ActivityItem[] = []
  for (const raw of [...recent, ...indexed]) {
    const key = `${raw.tx}-${raw.logIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    const it = decode(raw, abi, router)
    if (it && it.user) items.push(it)
  }
  return items
}

export async function fetchActivity(): Promise<Activity> {
  const jobs = [
    routerActivity(ROUTER_V1, routerEventsV1, ROUTER_V1_BLOCK, 'v1', false),
    routerActivity(ROUTER_V2, routerEventsV2, ROUTER_V2_BLOCK, 'v2', false),
    // v4 emits the same events as v3
    routerActivity(ROUTER_V3, routerEventsV3 as unknown as Abi, ROUTER_V3_BLOCK, 'v3', false),
  ]
  if (COIL_ROUTER && ![ROUTER_V1, ROUTER_V2, ROUTER_V3].some((a) => a.toLowerCase() === COIL_ROUTER!.toLowerCase())) {
    jobs.push(routerActivity(COIL_ROUTER, routerEventsV3 as unknown as Abi, ROUTER_V4_BLOCK, 'v4', true))
  }
  const all = (await Promise.all(jobs)).flat()
  all.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1))

  const wallets = new Set(all.filter((i) => i.kind !== 'IncentivesPushed').map((i) => i.user.toLowerCase())).size
  const walletsV2 = new Set(all.filter((i) => i.router !== 'v1' && i.kind !== 'IncentivesPushed').map((i) => i.user.toLowerCase())).size
  const fires = all.filter((i) => i.kind === 'GuardFired' || i.kind === 'ShieldFired' || i.kind === 'RecoilFired').length
  const total = new Set(all.map((i) => i.tx)).size

  // timestamps for the few recent items that came from the RPC
  const missing = [...new Set(all.slice(0, 60).filter((i) => !i.time).map((i) => i.block))]
  const stamps = new Map(
    await Promise.all(
      missing.map((b) =>
        client.getBlock({ blockNumber: b }).then((x) => [b, Number(x.timestamp) * 1000] as const).catch(() => [b, undefined] as const),
      ),
    ),
  )
  const items = all.map((i) => (i.time ? i : { ...i, time: stamps.get(i.block) }))
  return { items, wallets, walletsV2, total, fires }
}

/** Every CoilRouter event (v2 and v1), newest first, with explorer-ready tx hashes. */
export function useActivity() {
  return useQuery({ queryKey: ['activity'], queryFn: fetchActivity, refetchInterval: 30_000, retry: 2 })
}
