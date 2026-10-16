/**
 * Coil Guard keeper. Watches every armed Guard and fires it as soon as MUSD's price feed is at or
 * below its trigger. Anyone can run this: the keeper earns the Guard's bounty in BTC.
 *
 *   COIL_ROUTER=0x... KEEPER_PRIVATE_KEY=0x... npm start
 *   (optional) FROM_BLOCK=<router deploy block>  POLL_SECONDS=15  DRY_RUN=1
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseAbiItem, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.test.mezo.org'] } },
})

const ROUTER = process.env.COIL_ROUTER
if (!ROUTER) throw new Error('Set COIL_ROUTER to the deployed CoilRouter address')
const POLL = Number(process.env.POLL_SECONDS ?? 15) * 1000
const DRY = !!process.env.DRY_RUN

const abi = parseAbi([
  'function guardStatus(address user) view returns (bool armed, bool fresh, bool triggered)',
  'function fireGuard(address user, address upperHint, address lowerHint) returns (uint256)',
])
const armedEvent = parseAbiItem(
  'event GuardArmed(address indexed user, uint256 triggerPrice, uint256 collWithdrawal, uint256 debtRepay, uint256 bountyBps, uint256 deadline)',
)

const pub = createPublicClient({ chain: mezoTestnet, transport: http(undefined, { batch: true }) })
const account = process.env.KEEPER_PRIVATE_KEY ? privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY) : null
const wallet = account ? createWalletClient({ account, chain: mezoTestnet, transport: http() }) : null
if (!wallet && !DRY) throw new Error('Set KEEPER_PRIVATE_KEY (or DRY_RUN=1 to only watch)')

const users = new Set()
let cursor = BigInt(process.env.FROM_BLOCK ?? 0)

async function syncUsers() {
  const head = await pub.getBlockNumber()
  const step = 9_000n
  for (let from = cursor; from <= head; from += step) {
    const to = from + step - 1n > head ? head : from + step - 1n
    const logs = await pub.getLogs({ address: ROUTER, event: armedEvent, fromBlock: from, toBlock: to })
    logs.forEach((l) => users.add(l.args.user))
  }
  cursor = head + 1n
}

async function tick() {
  await syncUsers()
  for (const user of users) {
    const [armed, fresh, triggered] = await pub.readContract({ address: ROUTER, abi, functionName: 'guardStatus', args: [user] })
    if (!armed) { users.delete(user); continue }
    if (!fresh || !triggered) continue
    const zero = '0x0000000000000000000000000000000000000000'
    try {
      const { result, request } = await pub.simulateContract({
        account: account ?? undefined, address: ROUTER, abi, functionName: 'fireGuard', args: [user, zero, zero],
      })
      console.log(`[guard] ${user} is triggered, bounty ≈ ${formatEther(result)} BTC`)
      if (DRY) continue
      const hash = await wallet.writeContract(request)
      console.log(`[guard] fired for ${user}: ${hash}`)
      await pub.waitForTransactionReceipt({ hash })
    } catch (e) {
      console.warn(`[guard] ${user} could not fire: ${e.shortMessage ?? e.message}`)
    }
  }
}

console.log(`Coil keeper watching ${ROUTER} on Mezo testnet every ${POLL / 1000}s${DRY ? ' (dry run)' : ''}`)
for (;;) {
  try { await tick() } catch (e) { console.warn('[keeper] tick failed:', e.shortMessage ?? e.message) }
  await new Promise((r) => setTimeout(r, POLL))
}
