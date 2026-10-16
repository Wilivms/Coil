import { useQuery } from '@tanstack/react-query'
import { parseAbi, type Address, type Hash } from 'viem'
import { COIL_ROUTER } from './chain'
import { client } from './live'

/** CoilRouter deployment on Mezo testnet (block 16188308). */
export const DEPLOY_BLOCK = 16_188_308n
export const DEPLOY_TX = '0x724a7b45f0fec9fbb97eb427b80ade4e076092db2d2b0e4004794532514c0118' as Hash

const events = parseAbi([
  'event Coiled(address indexed user, uint256 deposit, uint256 totalColl, uint256 debtAmount, uint256 flashBtc, uint256 musdPaidToPool, uint256 musdRefund)',
  'event Unwound(address indexed user, uint256 musdRepaid, uint256 btcOut)',
  'event Delevered(address indexed user, uint256 collWithdrawn, uint256 debtRepaid, uint256 btcOut)',
  'event GuardArmed(address indexed user, uint256 triggerPrice, uint256 collWithdrawal, uint256 debtRepay, uint256 bountyBps, uint256 deadline)',
  'event GuardDisarmed(address indexed user)',
  'event GuardFired(address indexed user, address indexed keeper, uint256 price, uint256 btcToUser, uint256 bounty)',
])

export type ActivityKind = 'Coiled' | 'Unwound' | 'Delevered' | 'GuardArmed' | 'GuardDisarmed' | 'GuardFired'
export type ActivityItem = {
  kind: ActivityKind
  user: Address
  tx: Hash
  block: bigint
  time?: number
  args: Record<string, bigint | Address>
}

const CHUNK = 50_000n

async function logsBetween(from: bigint, to: bigint) {
  try {
    return await client.getLogs({ address: COIL_ROUTER!, events, fromBlock: from, toBlock: to })
  } catch (e) {
    if (to - from <= CHUNK) throw e
    // the RPC caps the range: split it
    const ranges: [bigint, bigint][] = []
    for (let a = from; a <= to; a += CHUNK) ranges.push([a, a + CHUNK - 1n > to ? to : a + CHUNK - 1n])
    const parts = await Promise.all(ranges.map(([a, b]) => client.getLogs({ address: COIL_ROUTER!, events, fromBlock: a, toBlock: b })))
    return parts.flat()
  }
}

export async function fetchActivity(): Promise<ActivityItem[]> {
  if (!COIL_ROUTER) return []
  const head = await client.getBlockNumber()
  const logs = await logsBetween(DEPLOY_BLOCK, head)
  const items: ActivityItem[] = logs
    .filter((l) => l.eventName && l.transactionHash && l.blockNumber !== null)
    .map((l) => ({
      kind: l.eventName as ActivityKind,
      user: (l.args as { user: Address }).user,
      tx: l.transactionHash!,
      block: l.blockNumber!,
      args: l.args as Record<string, bigint | Address>,
    }))
    .sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1))
    .slice(0, 40)
  const blocks = [...new Set(items.map((i) => i.block))]
  const stamps = await Promise.all(blocks.map((b) => client.getBlock({ blockNumber: b }).then((x) => [b, Number(x.timestamp) * 1000] as const).catch(() => [b, undefined] as const)))
  const at = new Map(stamps)
  return items.map((i) => ({ ...i, time: at.get(i.block) }))
}

/** Every CoilRouter event since deployment, newest first, with explorer-ready tx hashes. */
export function useActivity() {
  return useQuery({ queryKey: ['activity'], queryFn: fetchActivity, refetchInterval: 20_000, retry: 1 })
}
