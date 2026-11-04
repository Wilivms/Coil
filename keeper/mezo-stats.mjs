/**
 * Reproducible Mezo numbers quoted in Coil's README, deck and video.
 * Reads Mezo mainnet and testnet directly (JSON-RPC) and MUSD TroveManager history from the
 * public Blockscout API, and prints every figure with the block it was read at.
 *
 *   cd keeper && npm ci && npm run stats
 */
import { createPublicClient, formatEther, http, parseAbi } from 'viem'

const MAIN = {
  rpc: 'https://mainnet.mezo.public.validationcloud.io',
  api: 'https://api.explorer.mezo.org/api/v2',
  troveManager: '0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193',
  priceFeed: '0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88',
  musd: '0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186',
  btc: '0x7b7C000000000000000000000000000000000000',
  btcMusdPool: '0x52e604c44417233b6CcEDDDc0d640A405Caacefb',
}
const TEST = {
  rpc: 'https://rpc.test.mezo.org',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  btc: '0x7b7C000000000000000000000000000000000000',
  btcMusdPool: '0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9',
}

const abi = parseAbi([
  'function getTroveOwnersCount() view returns (uint256)',
  'function getEntireSystemColl() view returns (uint256)',
  'function getEntireSystemDebt() view returns (uint256)',
  'function getTCR(uint256) view returns (uint256)',
  'function fetchPrice() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

const n = (x, d = 0) => Number(formatEther(x)).toLocaleString('en-US', { maximumFractionDigits: d })

async function chain(name, c) {
  const cl = createPublicClient({ transport: http(c.rpc) })
  const block = await cl.getBlockNumber()
  const r = (address, functionName, args = []) => cl.readContract({ address, abi, functionName, args, blockNumber: block })
  const price = await r(c.priceFeed, 'fetchPrice')
  const [troves, coll, debt, tcr, supply, poolBtc, poolMusd] = await Promise.all([
    r(c.troveManager, 'getTroveOwnersCount'), r(c.troveManager, 'getEntireSystemColl'), r(c.troveManager, 'getEntireSystemDebt'),
    r(c.troveManager, 'getTCR', [price]), r(c.musd, 'totalSupply'), r(c.btc, 'balanceOf', [c.btcMusdPool]), r(c.musd, 'balanceOf', [c.btcMusdPool]),
  ])
  const poolPrice = Number(poolMusd) / Number(poolBtc)
  console.log(`\n## ${name} (block ${block})`)
  console.log(`BTC/USD (MUSD PriceFeed): $${n(price)}`)
  console.log(`Open troves: ${troves}  ·  collateral ${n(coll, 2)} BTC  ·  debt ${n(debt)} MUSD  ·  TCR ${(Number(tcr) / 1e16).toFixed(0)}%`)
  console.log(`MUSD supply: ${n(supply)}`)
  console.log(`MUSD/BTC pool: ${n(poolBtc, 3)} BTC + ${n(poolMusd)} MUSD  ·  pool price ${poolPrice.toFixed(0)} MUSD/BTC (${((poolPrice / (Number(price) / 1e18) - 1) * 100).toFixed(2)}% vs oracle)`)
  // slippage of a 0.1 BTC deposit at 3x: buy 0.2 BTC with MUSD on the x*y curve, 0.3% fee
  const out = 0.2, rB = Number(poolBtc) / 1e18, rM = Number(poolMusd) / 1e18
  if (out < rB) {
    const musdIn = (rM * out) / ((rB - out) * 0.997)
    console.log(`A 0.1 BTC coil at 3x would pay ${((musdIn / out / (rM / rB) - 1) * 100).toFixed(1)}% over the pool mid price`)
  }
}

async function redemptions() {
  // TroveManager logs via Blockscout (decoded), newest first
  const counts = {}, byMonth = {}
  let url = `${MAIN.api}/addresses/${MAIN.troveManager}/logs`, pages = 0, oldest
  while (url && pages < 400) {
    const j = await (await fetch(url)).json()
    for (const it of j.items ?? []) {
      const name = (it.decoded?.method_call ?? 'undecoded').split('(')[0]
      counts[name] = (counts[name] ?? 0) + 1
      oldest = it.block_number
      if (name === 'Redemption') {
        const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, BigInt(x.value)]))
        const m = (byMonth[it.block_number] = byMonth[it.block_number] ?? { musd: 0n, btc: 0n, n: 0 })
        m.musd += p._actualAmount; m.btc += p._collateralSent; m.n++
      }
    }
    const np = j.next_page_params
    url = np ? `${MAIN.api}/addresses/${MAIN.troveManager}/logs?${new URLSearchParams(Object.entries(np).map(([k, v]) => [k, String(v)]))}` : null
    pages++
  }
  let musd = 0n, btc = 0n
  for (const v of Object.values(byMonth)) { musd += v.musd; btc += v.btc }
  console.log(`\n## MUSD TroveManager history on mainnet (since block ${oldest})`)
  console.log(`Redemptions: ${counts.Redemption ?? 0}  ·  liquidations: ${counts.Liquidation ?? 0}`)
  console.log(`MUSD redeemed: ${n(musd)}  ·  BTC taken from troves by redemption: ${n(btc, 2)}`)
}

await chain('Mezo mainnet', MAIN)
await chain('Mezo testnet', TEST)
await redemptions()
