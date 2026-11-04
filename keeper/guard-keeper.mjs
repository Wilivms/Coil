/**
 * Coil keeper. Watches every armed Guard and Shield on CoilRouter v2 and fires them as soon as
 * their condition holds on-chain:
 *   - Guard:  MUSD's price feed is at or below the trigger (signed deleverage, BTC bounty)
 *   - Shield: price at or below its trigger, or little debt ahead in the redemption queue
 *             (signed repay from the user's Reserve, MUSD bounty)
 * The contract re-checks every condition itself, so a keeper can only fire what is due.
 * Anyone can run this.
 *
 *   COIL_ROUTER=0x... KEEPER_PRIVATE_KEY=0x... npm start
 *   optional: FROM_BLOCK=<router deploy block>  POLL_SECONDS=15  DRY_RUN=1  ONCE=1 (single pass)
 *             RUN_FOR_SECONDS=300 (poll for that long, then exit: used by the self-chaining GitHub Action)
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, formatEther } from 'viem'
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
const ONCE = !!process.env.ONCE
const STEPS = 200n // redemption-queue walk, capped by the contract
const ZERO = '0x0000000000000000000000000000000000000000'

const abi = parseAbi([
  'function guardStatus(address user) view returns (bool armed, bool fresh, bool triggered, bool recoveryMode)',
  'function fireGuard(address user, address upperHint, address lowerHint) returns (uint256)',
  'function shieldStatus(address user, uint256 maxSteps) view returns (bool armed, bool fresh, bool funded, bool byPrice, bool byQueue, uint256 ahead)',
  'function fireShield(address user, address upperHint, address lowerHint, uint256 maxSteps) returns (uint256)',
  'event GuardArmed(address indexed user, uint256 triggerPrice, uint256 collWithdrawal, uint256 debtRepay, uint256 minBtcOut, uint256 bountyBps, uint256 deadline)',
  'event ShieldArmed(address indexed user, uint256 repayAmount, uint256 triggerPrice, uint256 maxDebtAhead, uint256 bountyMusd, uint256 deadline)',
])
const events = abi.filter((x) => x.type === 'event')

const pub = createPublicClient({ chain: mezoTestnet, transport: http(undefined, { batch: true }) })
const account = process.env.KEEPER_PRIVATE_KEY ? privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY) : null
const wallet = account ? createWalletClient({ account, chain: mezoTestnet, transport: http() }) : null
if (!wallet && !DRY) throw new Error('Set KEEPER_PRIVATE_KEY (or DRY_RUN=1 to only watch)')

const guards = new Set()
const shields = new Set()
let cursor = BigInt(process.env.FROM_BLOCK || 0)
let fired = 0

async function syncUsers() {
  const head = await pub.getBlockNumber()
  const step = 9_000n
  for (let from = cursor; from <= head; from += step) {
    const to = from + step - 1n > head ? head : from + step - 1n
    const logs = await pub.getLogs({ address: ROUTER, events, fromBlock: from, toBlock: to })
    for (const l of logs) (l.eventName === 'GuardArmed' ? guards : shields).add(l.args.user)
  }
  cursor = head + 1n
}

async function fire(kind, user, functionName, args, unit) {
  try {
    const { result, request } = await pub.simulateContract({
      account: account ?? undefined, address: ROUTER, abi, functionName, args,
    })
    console.log(`[${kind}] ${user} is due, bounty ≈ ${formatEther(result)} ${unit}`)
    if (DRY) return
    const hash = await wallet.writeContract(request)
    await pub.waitForTransactionReceipt({ hash })
    console.log(`[${kind}] fired for ${user}: https://explorer.test.mezo.org/tx/${hash}`)
    fired++
  } catch (e) {
    console.warn(`[${kind}] ${user} could not fire: ${e.shortMessage ?? e.message}`)
  }
}

async function tick() {
  await syncUsers()
  for (const user of guards) {
    const [armed, fresh, triggered] = await pub.readContract({ address: ROUTER, abi, functionName: 'guardStatus', args: [user] })
    if (!armed) { guards.delete(user); continue }
    if (fresh && triggered) await fire('guard', user, 'fireGuard', [user, ZERO, ZERO], 'BTC')
  }
  for (const user of shields) {
    const [armed, fresh, funded, byPrice, byQueue, ahead] = await pub.readContract({
      address: ROUTER, abi, functionName: 'shieldStatus', args: [user, STEPS],
    })
    if (!armed) { shields.delete(user); continue }
    if (fresh && funded && (byPrice || byQueue)) {
      console.log(`[shield] ${user}: ${byQueue ? `${formatEther(ahead)} MUSD ahead in the redemption queue` : 'price trigger'}`)
      await fire('shield', user, 'fireShield', [user, ZERO, ZERO, STEPS], 'MUSD')
    }
  }
}

console.log(`Coil keeper watching ${ROUTER} on Mezo testnet${ONCE ? ' (single pass)' : ` every ${POLL / 1000}s`}${DRY ? ' (dry run)' : ''}`)
const RUN_FOR = Number(process.env.RUN_FOR_SECONDS ?? 0) * 1000
if (ONCE) {
  await tick()
  console.log(`[keeper] ${guards.size} Guards and ${shields.size} Shields armed, ${fired} fired this pass`)
} else if (RUN_FOR > 0) {
  const end = Date.now() + RUN_FOR
  let passes = 0
  while (Date.now() < end) {
    try { await tick(); passes++ } catch (e) { console.warn('[keeper] tick failed:', e.shortMessage ?? e.message) }
    await new Promise((r) => setTimeout(r, POLL))
  }
  console.log(`[keeper] ${passes} passes, ${guards.size} Guards and ${shields.size} Shields armed, ${fired} fired`)
} else {
  for (;;) {
    try { await tick() } catch (e) { console.warn('[keeper] tick failed:', e.shortMessage ?? e.message) }
    await new Promise((r) => setTimeout(r, POLL))
  }
}
