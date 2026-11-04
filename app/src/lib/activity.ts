import { useQuery } from '@tanstack/react-query'
import type { Abi, Address, Hash } from 'viem'
import { COIL_ROUTER, ROUTER_V1, ROUTER_V1_BLOCK, ROUTER_V2_BLOCK } from './chain'
import { routerEventsV1, routerEventsV2 } from './abis'
import { client } from './live'

/** v1 deployment transaction (Wave 1), still linked from the activity panel. */
export const DEPLOY_TX = '0x724a7b45f0fec9fbb97eb427b80ade4e076092db2d2b0e4004794532514c0118' as Hash

export type ActivityKind =
  | 'Coiled' | 'Unwound' | 'Delevered' | 'GuardArmed' | 'GuardDisarmed' | 'GuardFired'
  | 'ReserveDeposited' | 'ReserveWithdrawn' | 'ShieldArmed' | 'ShieldDisarmed' | 'ShieldFired'

export type ActivityItem = {
  kind: ActivityKind
  user: Address
  tx: Hash
  block: bigint
  router: 'v1' | 'v2'
  time?: number
  args: Record<string, bigint | Address | boolean>
}

const CHUNK = 50_000n

async function logsBetween(address: Address, events: Abi, from: bigint, to: bigint) {
  const get = (a: bigint, b: bigint) =>
    client.getLogs({ address, events: events as typeof routerEventsV2, fromBlock: a, toBlock: b })
  try {
    return await get(from, to)
  } catch (e) {
    if (to - from <= CHUNK) throw e
    // the RPC caps the range: split it
    const ranges: [bigint, bigint][] = []
    for (let a = from; a <= to; a += CHUNK) ranges.push([a, a + CHUNK - 1n > to ? to : a + CHUNK - 1n])
    return (await Promise.all(ranges.map(([a, b]) => get(a, b)))).flat()
  }
}

export async function fetchActivity(): Promise<ActivityItem[]> {
  const head = await client.getBlockNumber()
  const sources: { address: Address; events: Abi; from: bigint; router: 'v1' | 'v2' }[] = [
    { address: ROUTER_V1, events: routerEventsV1, from: ROUTER_V1_BLOCK, router: 'v1' },
  ]
  if (COIL_ROUTER && COIL_ROUTER.toLowerCase() !== ROUTER_V1.toLowerCase()) {
    sources.unshift({ address: COIL_ROUTER, events: routerEventsV2, from: ROUTER_V2_BLOCK || ROUTER_V1_BLOCK, router: 'v2' })
  }
  const all = await Promise.all(
    sources.map(async (s) =>
      (await logsBetween(s.address, s.events, s.from, head)).map((l) => ({ l, router: s.router })),
    ),
  )
  const items: ActivityItem[] = all
    .flat()
    .filter(({ l }) => l.eventName && l.transactionHash && l.blockNumber !== null)
    .map(({ l, router }) => ({
      kind: l.eventName as ActivityKind,
      user: (l.args as { user: Address }).user,
      tx: l.transactionHash!,
      block: l.blockNumber!,
      router,
      args: l.args as Record<string, bigint | Address | boolean>,
    }))
    .sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1))
    .slice(0, 60)
  const blocks = [...new Set(items.map((i) => i.block))]
  const stamps = await Promise.all(
    blocks.map((b) =>
      client.getBlock({ blockNumber: b }).then((x) => [b, Number(x.timestamp) * 1000] as const).catch(() => [b, undefined] as const),
    ),
  )
  const at = new Map(stamps)
  return items.map((i) => ({ ...i, time: at.get(i.block) }))
}

/** Every CoilRouter event (v2 and v1), newest first, with explorer-ready tx hashes. */
export function useActivity() {
  return useQuery({ queryKey: ['activity'], queryFn: fetchActivity, refetchInterval: 20_000, retry: 1 })
}
