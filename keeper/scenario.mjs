/**
 * Testnet scenario helpers for testing what normal use can't reach: a trove at the very front of the
 * redemption queue (Shield's queue trigger), a real redemption of OUR OWN trove only (claim leftover BTC),
 * and a Reserve left on v2 (the app's "move it" button). Test wallets only; they are listed as team
 * wallets on /proof.
 *
 *   OPS_KEY_FILE=... A_KEY_FILE=... node scenario.mjs <fund|open-tail|relower|redeem|v2reserve|status> [args]
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hintsFor } from './hints.mjs'

const chain = defineChain({ id: 31611, name: 'Mezo Testnet', nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } } })
const pub = createPublicClient({ chain, transport: http() })
const acct = (f) => { const k = readFileSync(f, 'utf8').trim(); return privateKeyToAccount(k.startsWith('0x') ? k : `0x${k}`) }
const ops = acct(process.env.OPS_KEY_FILE), A = acct(process.env.A_KEY_FILE)
const w = (a) => createWalletClient({ account: a, chain, transport: http() })

const BO = '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5', TM = '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0'
const FEED = '0x86bCF0841622a5dAC14A313a15f96A95421b9366', HH = '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6'
const SORTED = '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA', MUSD = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503'
const V2 = '0xA9aDbE2e3DDFbD3795Add019c8EA64a950777a92'
const abi = parseAbi([
  'function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable',
  'function withdrawMUSD(uint256 _amount, address _upperHint, address _lowerHint)',
  'function addColl(address _upperHint, address _lowerHint) payable',
  'function redeemCollateral(uint256 _amount, address _firstRedemptionHint, address _upperPartialRedemptionHint, address _lowerPartialRedemptionHint, uint256 _partialRedemptionHintNICR, uint256 _maxIterations)',
  'function getRedemptionHints(uint256 _amount, uint256 _price, uint256 _maxIterations) view returns (address, uint256, uint256)',
  'function fetchPrice() view returns (uint256)',
  'function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256)',
  'function getCurrentICR(address, uint256) view returns (uint256)',
  'function getLast() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
  'function depositReserve(uint256)',
  'function reserveBalance(address) view returns (uint256)',
])
const GAS_COMP = 200n * 10n ** 18n
const price = () => pub.readContract({ address: FEED, abi, functionName: 'fetchPrice' })
async function tx(label, a, address, functionName, args, value) {
  const { request } = await pub.simulateContract({ account: a, address, abi, functionName, args, value })
  const gas = await pub.estimateGas({ account: a, to: address, data: (await import('viem')).encodeFunctionData({ abi, functionName, args }), value })
  const hash = await w(a).writeContract({ ...request, gas: (gas * 3n) / 2n < 600_000n ? 600_000n : (gas * 3n) / 2n })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${label} reverted ${hash}`)
  console.log(`✓ ${label.padEnd(26)} ${hash}`)
  return hash
}
async function status() {
  const p = await price()
  const [c, pr, i] = await pub.readContract({ address: TM, abi, functionName: 'getEntireDebtAndColl', args: [A.address] })
  const icr = pr + i > 0n ? Number(await pub.readContract({ address: TM, abi, functionName: 'getCurrentICR', args: [A.address, p] })) / 1e16 : 0
  const last = await pub.readContract({ address: SORTED, abi, functionName: 'getLast' })
  console.log(`A ${A.address}: ${formatEther(await pub.getBalance({ address: A.address }))} BTC, ${formatEther(await pub.readContract({ address: MUSD, abi, functionName: 'balanceOf', args: [A.address] }))} MUSD, trove ${formatEther(c)} BTC / ${formatEther(pr + i)} MUSD, ICR ${icr.toFixed(1)}%, front of the queue: ${last.toLowerCase() === A.address.toLowerCase()}`)
  console.log(`ops ${formatEther(await pub.getBalance({ address: ops.address }))} BTC, ${formatEther(await pub.readContract({ address: MUSD, abi, functionName: 'balanceOf', args: [ops.address] }))} MUSD; price ${Number(p) / 1e18}`)
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'fund') {
  const hash = await w(ops).sendTransaction({ to: A.address, value: parseEther(arg ?? '0.034') })
  await pub.waitForTransactionReceipt({ hash }); console.log('✓ fund A', hash)
} else if (cmd === 'open-tail') {
  // a plain MUSD trove (not opened with Coil) at ~112%: the lowest ratio above 110% in the queue
  const target = Number(arg ?? 1.12)
  const p = Number(await price()) / 1e18
  const borrow = 1800n * 10n ** 18n
  const total = 1800 * 1.001 + 200
  const coll = parseEther(((total * target) / p).toFixed(6))
  const [u, l] = await hintsFor(pub, coll, borrow + GAS_COMP)
  await tx('openTrove (plain MUSD)', A, BO, 'openTrove', [borrow, u, l], coll)
} else if (cmd === 'addcoll') {
  const v = parseEther(arg ?? '0.005')
  const [c, pr, i] = await pub.readContract({ address: TM, abi, functionName: 'getEntireDebtAndColl', args: [A.address] })
  const [u, l] = await hintsFor(pub, c + v, pr + i)
  await tx('addColl', A, BO, 'addColl', [u, l], v)
} else if (cmd === 'relower') {
  // borrow more so the ratio is back at ~target (after a Shield repay moved it up)
  const target = Number(arg ?? 1.12)
  const p = await price()
  const [c, pr, i] = await pub.readContract({ address: TM, abi, functionName: 'getEntireDebtAndColl', args: [A.address] })
  const want = (c * p * 1000n) / BigInt(Math.round(target * 1000)) / 10n ** 18n
  const add = ((want - (pr + i)) * 1000n) / 1001n
  if (add <= 0n) console.log('already at or under target')
  else {
    const [u, l] = await hintsFor(pub, c, want)
    await tx(`withdrawMUSD ${formatEther(add).slice(0, 7)}`, A, BO, 'withdrawMUSD', [add, u, l])
  }
} else if (cmd === 'redeem') {
  // redeem exactly A's trove, and nothing else: A must be the front of the queue; maxIterations = 1
  const p = await price()
  const last = await pub.readContract({ address: SORTED, abi, functionName: 'getLast' })
  if (last.toLowerCase() !== A.address.toLowerCase()) throw new Error(`A is not the front of the queue (${last}): refusing, it would redeem someone else`)
  const [, pr, i] = await pub.readContract({ address: TM, abi, functionName: 'getEntireDebtAndColl', args: [A.address] })
  const amount = pr + i - GAS_COMP
  const mine = await pub.readContract({ address: MUSD, abi, functionName: 'balanceOf', args: [A.address] })
  if (mine > 0n) await tx('A sends its MUSD to ops', A, MUSD, 'transfer', [ops.address, mine])
  const [first, nicr, truncated] = await pub.readContract({ address: HH, abi, functionName: 'getRedemptionHints', args: [amount, p, 1n] })
  if (first.toLowerCase() !== A.address.toLowerCase() || truncated !== amount) throw new Error(`hints say ${first} / ${truncated}: refusing`)
  await tx(`redeem ${formatEther(amount).slice(0, 8)} MUSD`, ops, TM, 'redeemCollateral', [amount, first, A.address, A.address, nicr, 1n])
} else if (cmd === 'v2reserve') {
  const amt = parseEther(arg ?? '50')
  await tx('approve v2', A, MUSD, 'approve', [V2, amt])
  await tx('v2 depositReserve', A, V2, 'depositReserve', [amt])
}
await status()
