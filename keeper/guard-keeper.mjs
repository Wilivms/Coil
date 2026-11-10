/**
 * Coil keeper. Watches every armed Guard, Shield and Recoil on CoilRouter v3 and fires them as soon
 * as their condition holds on-chain, and pushes the MUSD collected for the gauge:
 *   - Guard:  MUSD's price feed is at or below the trigger (signed deleverage, BTC bounty)
 *   - Shield: price at or below its trigger, or little debt ahead in the redemption queue
 *             (signed repay from the user's Reserve, MUSD bounty)
 *   - Recoil: the trove's ratio is back above its trigger (signed leverage-up, MUSD bounty)
 *   - pushIncentives: sends collected MUSD to the MUSD/BTC gauge incentives (no bounty)
 * The contract re-checks every condition itself, so a keeper can only fire what is due.
 * Anyone can run this.
 *
 *   COIL_ROUTER=0x... COIL_LENS=0x... KEEPER_PRIVATE_KEY=0x... npm start
 *   optional: FROM_BLOCK=<router deploy block>  POLL_SECONDS=15  DRY_RUN=1  ONCE=1 (single pass)
 *             RUN_FOR_SECONDS=300 (poll for that long, then exit: used by the self-chaining GitHub Action)
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, formatEther, encodeFunctionData } from 'viem'
// The RPC's gas estimate has come back far too low right after a state change (32,742 gas on a
// fireShield that needs ~600k): never send less than this. Only gas used is paid.
const GAS_FLOOR = 1_500_000n
import { privateKeyToAccount } from 'viem/accounts'

const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.test.mezo.org'] } },
})

const ROUTER = process.env.COIL_ROUTER
if (!ROUTER) throw new Error('Set COIL_ROUTER to the deployed CoilRouter address')
const LENS = process.env.COIL_LENS
if (!LENS) throw new Error('Set COIL_LENS to the deployed CoilLens address')
const POLL = Number(process.env.POLL_SECONDS ?? 15) * 1000
const DRY = !!process.env.DRY_RUN
const ONCE = !!process.env.ONCE
const STEPS = 200n // redemption-queue walk, capped by the contract
const ZERO = '0x0000000000000000000000000000000000000000'

const lensAbi = parseAbi([
  'function guardStatus(address user) view returns (bool armed, bool fresh, bool triggered, bool recoveryMode)',
  'function shieldStatus(address user, uint256 maxSteps) view returns (bool armed, bool fresh, bool funded, bool byPrice, bool byQueue, uint256 ahead)',
  'function recoilStatus(address user) view returns (bool armed, bool fresh, bool triggered, uint256 icr, uint256 capacity)',
])
const abi = parseAbi([
  'function fireGuard(address user, address upperHint, address lowerHint) returns (uint256)',
  'function fireShield(address user, address upperHint, address lowerHint, uint256 maxSteps) returns (uint256)',
  'function fireRecoil(address user, address upperHint, address lowerHint) returns (uint256)',
  'function pushIncentives() returns (uint256)',
  'function pendingIncentives() view returns (uint256)',
  'event RecoilArmed(address indexed user, uint256 triggerIcr, uint256 addColl, uint256 debtIncrease, uint256 bountyBps, uint256 deadline)',
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
const recoils = new Set()
let lastPush = 0
let cursor = BigInt(process.env.FROM_BLOCK || 0)
let fired = 0

async function syncUsers() {
  const head = await pub.getBlockNumber()
  const step = 9_000n
  for (let from = cursor; from <= head; from += step) {
    const to = from + step - 1n > head ? head : from + step - 1n
    const logs = await pub.getLogs({ address: ROUTER, events, fromBlock: from, toBlock: to })
    for (const l of logs) ({ GuardArmed: guards, ShieldArmed: shields, RecoilArmed: recoils })[l.eventName].add(l.args.user)
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
    // Hints are zero, so MUSD's SortedTroves walks the list: leave a 50% gas margin so an inner
    // call can't run out of gas (63/64 rule) while the estimate still passes.
    const gas = await pub.estimateGas({ account, to: ROUTER, data: encodeFunctionData({ abi, functionName, args }) })
    const hash = await wallet.writeContract({ ...request, gas: [(gas * 3n) / 2n, GAS_FLOOR, 9_500_000n].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[1] }) // clamp to [floor, 9.5M]; Mezo's block limit is 10M
    const rc = await pub.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`reverted on-chain: ${hash}`)
    console.log(`[${kind}] fired for ${user}: https://explorer.test.mezo.org/tx/${hash}`)
    fired++
  } catch (e) {
    console.warn(`[${kind}] ${user} could not fire: ${e.shortMessage ?? e.message}`)
  }
}

async function tick() {
  await syncUsers()
  for (const user of guards) {
    const [armed, fresh, triggered] = await pub.readContract({ address: LENS, abi: lensAbi, functionName: 'guardStatus', args: [user] })
    if (!armed) { guards.delete(user); continue }
    if (fresh && triggered) await fire('guard', user, 'fireGuard', [user, ZERO, ZERO], 'BTC')
  }
  for (const user of shields) {
    const [armed, fresh, funded, byPrice, byQueue, ahead] = await pub.readContract({
      address: LENS, abi: lensAbi, functionName: 'shieldStatus', args: [user, STEPS],
    })
    if (!armed) { shields.delete(user); continue }
    if (fresh && funded && (byPrice || byQueue)) {
      console.log(`[shield] ${user}: ${byQueue ? `${formatEther(ahead)} MUSD ahead in the redemption queue` : 'price trigger'}`)
      await fire('shield', user, 'fireShield', [user, ZERO, ZERO, STEPS], 'MUSD')
    }
  }
  for (const user of recoils) {
    const [armed, fresh, triggered, icr] = await pub.readContract({ address: LENS, abi: lensAbi, functionName: 'recoilStatus', args: [user] })
    if (!armed) { recoils.delete(user); continue }
    if (fresh && triggered) {
      console.log(`[recoil] ${user}: ratio ${(Number(icr) / 1e16).toFixed(0)}%, back to target leverage`)
      await fire('recoil', user, 'fireRecoil', [user, ZERO, ZERO], 'MUSD')
    }
  }
  // gauge incentives: push what was collected, at most every 10 minutes
  if (Date.now() - lastPush > 600_000) {
    const pending = await pub.readContract({ address: ROUTER, abi, functionName: 'pendingIncentives' })
    if (pending > 0n) await fire('incentives', 'MUSD/BTC gauge', 'pushIncentives', [], 'MUSD')
    lastPush = Date.now()
  }
}

console.log(`Coil keeper watching ${ROUTER} on Mezo testnet${ONCE ? ' (single pass)' : ` every ${POLL / 1000}s`}${DRY ? ' (dry run)' : ''}`)
const RUN_FOR = Number(process.env.RUN_FOR_SECONDS ?? 0) * 1000
if (ONCE) {
  await tick()
  console.log(`[keeper] ${guards.size} Guards, ${shields.size} Shields, ${recoils.size} Recoils armed, ${fired} fired this pass`)
} else if (RUN_FOR > 0) {
  const end = Date.now() + RUN_FOR
  let passes = 0
  while (Date.now() < end) {
    try { await tick(); passes++ } catch (e) { console.warn('[keeper] tick failed:', e.shortMessage ?? e.message) }
    await new Promise((r) => setTimeout(r, POLL))
  }
  console.log(`[keeper] ${passes} passes, ${guards.size} Guards, ${shields.size} Shields, ${recoils.size} Recoils armed, ${fired} fired`)
} else {
  for (;;) {
    try { await tick() } catch (e) { console.warn('[keeper] tick failed:', e.shortMessage ?? e.message) }
    await new Promise((r) => setTimeout(r, POLL))
  }
}
