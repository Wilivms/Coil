/**
 * End-to-end run of every CoilRouter v3 flow on Mezo testnet with one wallet:
 * coil -> Reserve -> Shield (keeper) -> leverage up -> Recoil (keeper) -> Guard (keeper)
 * -> deleverage -> pushIncentives -> withdraw Reserve -> unwind.
 * Each protection is armed already-triggered; the always-on keeper gets WAIT seconds to fire it,
 * then this script fires it itself (anyone can).
 *
 *   E2E_PRIVATE_KEY=0x... node e2e.mjs        (or E2E_KEY_FILE=path)
 *   optional: DEPOSIT=0.03 LEVERAGE=2.2 WAIT=120 KEEP_OPEN=1
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, encodeFunctionData, parseEther, formatEther } from 'viem'
import { fireHints, hintsFor } from './hints.mjs'
import { privateKeyToAccount } from 'viem/accounts'

const chain = defineChain({
  id: 31611, name: 'Mezo Testnet', nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.test.mezo.org'] } },
})
const ROUTER = '0x17e056ef7e076Fbcb806dF9916552A26Da527F03'
const LENS = '0xa82154DD7bf08840F4D9d97a44999C4D4F76d8f5'
const BOS = '0xD757e3646AF370b15f32EB557F0F8380Df7D639e'
const TM = '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0'
const FEED = '0x86bCF0841622a5dAC14A313a15f96A95421b9366'
const MUSD = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503'
const Z = '0x0000000000000000000000000000000000000000'
const WAD = 10n ** 18n

const key = (process.env.E2E_PRIVATE_KEY ?? readFileSync(process.env.E2E_KEY_FILE, 'utf8')).trim()
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const me = account.address
const pub = createPublicClient({ chain, transport: http() })
const wallet = createWalletClient({ account, chain, transport: http() })

const router = parseAbi([
  'function coil(uint256,uint256,address,address,bytes,uint256,uint16) payable returns (uint256)',
  'function relever(uint256,uint256,address,address,bytes,bytes,uint256,uint256,uint16) returns (uint256)',
  'function armRecoil(uint128,uint128,uint128,uint16,uint64,bytes,bytes)',
  'function fireRecoil(address,address,address) returns (uint256)',
  'function disarmRecoil()',
  'function unwind(bytes,uint256,uint256,uint16) returns (uint256)',
  'function deleverage(uint256,uint256,address,address,bytes,uint256,uint256,uint16) returns (uint256)',
  'function closeAmount(address) view returns (uint256)',
  'function armGuard(uint128,uint128,uint128,uint128,uint16,uint64,bytes)',
  'function fireGuard(address,address,address) returns (uint256)',
  'function depositReserve(uint256)',
  'function withdrawReserve(uint256)',
  'function reserveBalance(address) view returns (uint256)',
  'function armShield(uint128,uint128,uint128,uint128,uint64,bytes)',
  'function fireShield(address,address,address,uint256) returns (uint256)',
  'function pushIncentives() returns (uint256)',
  'function pendingIncentives() view returns (uint256)',
  'function quoteMusdForBtc(uint256) view returns (uint256)',
  'function quoteBtcForMusd(uint256) view returns (uint256)',
  'function guardOf(address) view returns ((uint128,uint128,uint128,uint128,uint64,uint16,uint64,bytes))',
  'function shieldOf(address) view returns ((uint128,uint128,uint128,uint128,uint64,uint64,bytes))',
  'function recoilOf(address) view returns ((uint128,uint128,uint128,uint64,uint16,uint64,bytes,bytes))',
])
const other = parseAbi([
  'function getNonce(address) view returns (uint256)',
  'function fetchPrice() returns (uint256)',
  'function getEntireDebtAndColl(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getTroveStatus(address) view returns (uint256)',
  'function getCurrentICR(address,uint256) view returns (uint256)',
  'function checkRecoveryMode(uint256) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

const domain = { name: 'BorrowerOperationsSignatures', version: '1', chainId: 31611, verifyingContract: BOS }
const T = {
  OpenTrove: [['assetAmount', 'uint256'], ['debtAmount', 'uint256'], ['borrower', 'address'], ['recipient', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']],
  CloseTrove: [['borrower', 'address'], ['recipient', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']],
  AdjustTrove: [['collWithdrawal', 'uint256'], ['debtChange', 'uint256'], ['isDebtIncrease', 'bool'], ['assetAmount', 'uint256'], ['borrower', 'address'], ['recipient', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']],
  RepayMUSD: [['amount', 'uint256'], ['borrower', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']],
}
const nonce = () => pub.readContract({ address: BOS, abi: other, functionName: 'getNonce', args: [me] })
async function sign(type, message) {
  const types = { [type]: T[type].map(([name, type]) => ({ name, type })) }
  return wallet.signTypedData({ domain, types, primaryType: type, message: { ...message, nonce: await nonce() } })
}
const r = (fn, args = []) => pub.readContract({ address: ROUTER, abi: router, functionName: fn, args })
const price = async () => (await pub.simulateContract({ address: FEED, abi: other, functionName: 'fetchPrice' })).result
const trove = () => pub.readContract({ address: TM, abi: other, functionName: 'getEntireDebtAndColl', args: [me] })
const deadline = (s = 3600) => BigInt(Math.floor(Date.now() / 1000) + s)
const fmt = (x, d = 4) => Number(formatEther(x)).toFixed(d)
const log = []
async function send(label, address, abi, functionName, args, value) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args, value })
  // MUSD's SortedTroves walks the list without hints; leave room so an inner call can't run out of gas
  const gas = await pub.estimateGas({ account, to: address, data: encodeFunctionData({ abi, functionName, args }), value })
  const hash = await wallet.writeContract({ ...request, gas: min(max((gas * 3n) / 2n, GAS_FLOOR), GAS_CAP) })
  const rc = await pub.waitForTransactionReceipt({ hash })
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`)
  console.log(`✓ ${label.padEnd(22)} ${hash}  gas ${rc.gasUsed}`)
  log.push({ step: label, tx: hash, block: Number(rc.blockNumber), by: 'e2e' })
  return rc
}
// v4: the borrower's own PriceFeed tolerance for a trade they send (same rule as app/src/lib/tolerance.ts)
function tol(paid, fair) {
  const need = Number(((paid - fair) * 10_000n) / fair) + 75
  return need <= 300 ? 0 : Math.min(Math.ceil(need / 25) * 25, 2000)
}
const buyTol = async (btc) => tol(await r('quoteMusdForBtc', [btc]), (btc * (await price())) / WAD)
const sellTol = async (m) => tol(((await r('quoteBtcForMusd', [m])) * (await price())) / WAD, m)
// The RPC's gas estimate has come back far too low right after a state change (32,742 gas on a
// fireShield that needs ~600k): never send less than this. Only gas used is paid.
const GAS_FLOOR = 1_500_000n
const max = (a, b) => (a > b ? a : b)
const min = (a, b) => (a < b ? a : b)
const GAS_CAP = 9_500_000n // Mezo's block gas limit is 10M
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
const WAIT = Number(process.env.WAIT ?? 120)
async function waitForKeeper(label, isArmed, fire) {
  const until = Date.now() + WAIT * 1000
  while (Date.now() < until) {
    if (!(await isArmed())) {
      console.log(`✓ ${label.padEnd(22)} fired by the keeper`)
      log.push({ step: label, by: 'keeper' })
      return
    }
    await sleep(5000)
  }
  await fire()
}

const s0 = await pub.getBalance({ address: me })
const p0 = await price()
const rm = await pub.readContract({ address: TM, abi: other, functionName: 'checkRecoveryMode', args: [p0] })
console.log(`wallet ${me}  ${fmt(s0)} BTC  price ${fmt(p0, 0)}  recovery ${rm}`)
const st = await pub.readContract({ address: TM, abi: other, functionName: 'getTroveStatus', args: [me] })
const RESUME = !!process.env.RESUME
if (st === 1n && !RESUME) throw new Error('wallet already has an open trove (RESUME=1 to continue from leverage up)')

const deposit = parseEther(process.env.DEPOSIT ?? '0.03')
let dl
if (!RESUME) {
// 1. coil, with 12% extra debt refunded as MUSD to fund the Reserve
const lev = Number(process.env.LEVERAGE ?? 2.2)
const totalColl = (deposit * BigInt(Math.round(lev * 1000))) / 1000n
const flash = totalColl - deposit
const debt = ((await r('quoteMusdForBtc', [flash])) * 112n) / 100n
dl = deadline()
await send('coil', ROUTER, router, 'coil', [totalColl, debt, ...(await hintsFor(pub, totalColl, (debt * 1001n) / 1000n + 200n * WAD)),
  await sign('OpenTrove', { assetAmount: totalColl, debtAmount: debt, borrower: me, recipient: ROUTER, deadline: dl }), dl, await buyTol(flash)], deposit)
let [c, pr, int] = await trove()
console.log(`  trove ${fmt(c)} BTC / ${fmt(pr + int, 0)} MUSD  ICR ${fmt(await pub.readContract({ address: TM, abi: other, functionName: 'getCurrentICR', args: [me, await price()] }), 3)}`)

// 2. Reserve
const musd = await pub.readContract({ address: MUSD, abi: other, functionName: 'balanceOf', args: [me] })
await send('approve MUSD', MUSD, other, 'approve', [ROUTER, musd])
await send('depositReserve', ROUTER, router, 'depositReserve', [musd])

// 3. Shield, armed above the current price so it is due now
const repay = 100n * WAD, bounty = 1n * WAD
dl = deadline(86400)
await send('armShield', ROUTER, router, 'armShield', [repay, ((await price()) * 110n) / 100n, 0n, bounty, dl,
  await sign('RepayMUSD', { amount: repay, borrower: me, deadline: dl })])
await waitForKeeper('fireShield', async () => (await r('shieldOf', [me]))[6] !== '0x',
  async () => send('fireShield', ROUTER, router, 'fireShield', [me, ...(await fireHints(pub, ROUTER, 'shield', me)), 200n]))

} else if ((await r('shieldOf', [me]))[6] !== '0x') {
  await send('fireShield', ROUTER, router, 'fireShield', [me, ...(await fireHints(pub, ROUTER, 'shield', me)), 200n])
}

// 4. leverage up
const add = deposit / 3n
const inc = ((await r('quoteMusdForBtc', [add])) * 1015n) / 1000n
dl = deadline()
await send('relever', ROUTER, router, 'relever', [add, inc, ...(await hintsFor(pub, (await trove())[0] + add, (await trove())[1] + (inc * 1001n) / 1000n)),
  await sign('AdjustTrove', { collWithdrawal: 0n, debtChange: inc, isDebtIncrease: true, assetAmount: add, borrower: me, recipient: ROUTER, deadline: dl }), '0x', dl, 0n, await buyTol(add)])

// 5. Recoil, trigger at MCR so it is due now
const add2 = deposit / 6n
const inc2 = ((await r('quoteMusdForBtc', [add2])) * 1015n) / 1000n
dl = deadline(86400)
await send('armRecoil', ROUTER, router, 'armRecoil', [11n * WAD / 10n, add2, inc2, 10, dl,
  await sign('AdjustTrove', { collWithdrawal: 0n, debtChange: inc2, isDebtIncrease: true, assetAmount: add2, borrower: me, recipient: ROUTER, deadline: dl }), '0x'])
if ((await buyTol(add2)) === 0) {
  await waitForKeeper('fireRecoil', async () => (await r('recoilOf', [me]))[6] !== '0x',
    async () => send('fireRecoil', ROUTER, router, 'fireRecoil', [me, ...(await fireHints(pub, ROUTER, 'recoil', me))]))
} else {
  // The pool prices BTC past the 3% bound: a keeper must not buy BTC for the user there, whatever the bounty.
  try {
    await pub.simulateContract({ account, address: ROUTER, abi: router, functionName: 'fireRecoil', args: [me, Z, Z] })
    throw new Error('fireRecoil should have been refused by the oracle bound')
  } catch (e) {
    if (!String(e.shortMessage ?? e.message).match(/PriceDeviation|revert/i)) throw e
    console.log('✓ fireRecoil             refused by the oracle bound (pool past 3%), as designed')
    log.push({ step: 'fireRecoil refused (PriceDeviation)', by: 'contract' })
  }
  await send('disarmRecoil', ROUTER, router, 'disarmRecoil', [])
}

// 6. Guard, armed above the current price so it is due now
const gRepay = 300n * WAD
const gWithdraw = ((await r('quoteBtcForMusd', [gRepay])) * 106n) / 100n
dl = deadline(86400)
await send('armGuard', ROUTER, router, 'armGuard', [((await price()) * 110n) / 100n, gWithdraw, gRepay, gWithdraw / 50n, 50, dl,
  await sign('AdjustTrove', { collWithdrawal: gWithdraw, debtChange: gRepay, isDebtIncrease: false, assetAmount: 0n, borrower: me, recipient: ROUTER, deadline: dl })])
await waitForKeeper('fireGuard', async () => (await r('guardOf', [me]))[7] !== '0x',
  async () => send('fireGuard', ROUTER, router, 'fireGuard', [me, ...(await fireHints(pub, ROUTER, 'guard', me))]))

// 7. manual deleverage
const dRepay = 200n * WAD
const dWithdraw = ((await r('quoteBtcForMusd', [dRepay])) * 105n) / 100n
dl = deadline()
await send('deleverage', ROUTER, router, 'deleverage', [dWithdraw, dRepay, ...(await hintsFor(pub, (await trove())[0] - dWithdraw, (await trove())[1] - dRepay)),
  await sign('AdjustTrove', { collWithdrawal: dWithdraw, debtChange: dRepay, isDebtIncrease: false, assetAmount: 0n, borrower: me, recipient: ROUTER, deadline: dl }), dl, 1n, await sellTol(dRepay)])

// 8. incentives to the gauge (the keeper pushes them every 10 min; push now if any are left)
if ((await r('pendingIncentives')) > 0n) await send('pushIncentives', ROUTER, router, 'pushIncentives', [])

// 9. Reserve out, yield included
await send('withdrawReserve', ROUTER, router, 'withdrawReserve', [await r('reserveBalance', [me])])

// 10. unwind
if (!process.env.KEEP_OPEN) {
  dl = deadline()
  await send('unwind', ROUTER, router, 'unwind', [await sign('CloseTrove', { borrower: me, recipient: ROUTER, deadline: dl }), dl, 0n, await sellTol(await r('closeAmount', [me]))])
}
const s1 = await pub.getBalance({ address: me })
const m1 = await pub.readContract({ address: MUSD, abi: other, functionName: 'balanceOf', args: [me] })
console.log(`done: ${fmt(s1)} BTC (${fmt(s1 - s0, 5)}), ${fmt(m1, 2)} MUSD left`)
console.log(JSON.stringify(log))
