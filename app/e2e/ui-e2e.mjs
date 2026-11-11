/**
 * The app, driven like a person would, against Mezo testnet: a real browser, the real UI, and a test
 * wallet injected as `window.ethereum` (EIP-1193) that signs with a local key. Every click sends a real
 * transaction. Screenshots of each step land in e2e/out/.
 *
 *   E2E_KEY_FILE=path/to/key APP_URL=https://coil-mezo-blitz-bet.vercel.app node e2e/ui-e2e.mjs
 *
 * Steps: connect · coil 0.025 BTC at 2x · Guard "Test it now" → keeper fires it (or we fire it
 * ourselves from the app) · Leverage up · Deleverage · Unwind.
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const chain = defineChain({ id: 31611, name: 'Mezo Testnet', nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } } })
const key = readFileSync(process.env.E2E_KEY_FILE, 'utf8').trim()
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const pub = createPublicClient({ chain, transport: http() })
const wallet = createWalletClient({ account, chain, transport: http() })
const APP = process.env.APP_URL ?? 'https://coil-mezo-blitz-bet.vercel.app'
const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const log = []

/** EIP-1193 requests from the page, answered in Node with the test key. */
async function handle(method, params = []) {
  switch (method) {
    case 'eth_requestAccounts': case 'eth_accounts': return [account.address]
    case 'eth_chainId': return '0x7b7b'
    case 'net_version': return '31611'
    case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null
    case 'wallet_requestPermissions': case 'wallet_getPermissions': return [{ parentCapability: 'eth_accounts' }]
    case 'eth_signTypedData_v4': {
      const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
      const { EIP712Domain, ...types } = td.types
      return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message })
    }
    case 'personal_sign': return account.signMessage({ message: { raw: params[0] } })
    case 'eth_sendTransaction': {
      const t = params[0]
      const hash = await wallet.sendTransaction({
        to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n, gas: t.gas ? BigInt(t.gas) : undefined,
      })
      log.push({ hash })
      console.log('   tx', hash)
      return hash
    }
    default: return pub.request({ method, params })
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('pageerror', (e) => console.log('   pageerror', e.message.slice(0, 160)))
await page.exposeFunction('__coilWallet', async (method, params) => {
  try { return { ok: await handle(method, params) } } catch (e) {
    if (process.env.DEBUG) console.log('   wallet error', method, (e.shortMessage ?? e.message).slice(0, 200), JSON.stringify(params, (k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 300))
    return { err: e.shortMessage ?? e.message }
  }
})
await page.addInitScript((address) => {
  const listeners = {}
  const provider = {
    isMetaMask: false,
    request: async ({ method, params }) => {
      const r = await window.__coilWallet(method, params ?? [])
      if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
      return r.ok
    },
    on: (e, f) => { (listeners[e] ??= []).push(f) },
    removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f) },
    selectedAddress: address,
    chainId: '0x7b7b',
  }
  window.ethereum = provider
  const info = { uuid: '6f1d1d58-0b31-4a3e-9c8e-c011e2e00001', name: 'Coil E2E Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'app.coil.e2e' }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
}, account.address)

const shot = (n) => page.screenshot({ path: `${OUT}${String(log.length).padStart(2, '0')}-${n}.png`, fullPage: false })
const text = () => page.evaluate(() => document.body.innerText)
/** Wait for a toast (the app's own success or failure message), not text that may sit elsewhere on the page. */
async function waitToast(re, ms = 180_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const t = (await page.locator('.toasts').innerText().catch(() => '')) || ''
    const failed = t.match(/[A-Z][\w ]+ failed\n?[^\n]*/)
    if (failed) throw new Error(failed[0])
    if (re.test(t)) return true
    await page.waitForTimeout(1000)
  }
  throw new Error(`timeout waiting for toast ${re}`)
}
async function waitText(re, ms = 120_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const t = await text()
    const failed = t.match(/[A-Z][\w ]+ failed\n?[^\n]*/)
    if (failed) throw new Error(failed[0])
    if (re.test(t)) return true
    await page.waitForTimeout(2000)
  }
  throw new Error(`timeout waiting for ${re}`)
}
async function step(name, fn) {
  const t0 = Date.now()
  try { await fn(); console.log(`✓ ${name} (${Math.round((Date.now() - t0) / 1000)} s)`); await shot(name.replace(/\W+/g, '-')) }
  catch (e) { await shot('FAILED-' + name.replace(/\W+/g, '-')); console.log(`✗ ${name}: ${e.message}`); throw e }
}

await step('open the app', async () => {
  await page.goto(`${APP}/#/app`, { waitUntil: 'networkidle' })
  await waitText(/Build a position|Your position/)
})

await step('connect the wallet', async () => {
  await page.waitForTimeout(3000)
  const short = `${account.address.slice(0, 4)}...${account.address.slice(-4)}`.toLowerCase()
  for (let i = 0; i < 10; i++) {
    const t = (await page.locator('header, nav').first().innerText().catch(() => '')).toLowerCase()
    if (t.includes(short) || t.includes(short.replace('...', '…'))) return // wagmi reconnected the injected wallet
    await page.waitForTimeout(1500)
  } // wagmi reconnected the injected wallet
  await page.getByRole('button', { name: /connect/i }).first().click()
  await page.getByText(/Coil E2E Wallet|Browser Wallet|Injected/i).first().click()
  await waitText(new RegExp(account.address.slice(2, 6), 'i'), 30_000).catch(() => {})
})

await step('coil 0.025 BTC at 2x', async () => {
  if (/Your position/.test(await text())) { console.log('   (trove already open: continuing with it)'); return }
  await page.fill('#deposit', '0.025')
  await page.getByRole('button', { name: '2×', exact: true }).click()
  await page.getByRole('button', { name: /Sign and coil/ }).click()
  await waitToast(/Position open/)
  await waitText(/Your position/, 60_000)
  await page.waitForTimeout(12_000) // let the app reload the new trove before the next click
})

await step('Guard: Test it now', async () => {
  await page.locator('#guard-h').scrollIntoViewIfNeeded()
  const sec = page.locator('section[aria-labelledby="guard-h"]')
  const pill = () => sec.locator('.pill').first().innerText()
  if (process.env.DEBUG) console.log('   guard pill:', await pill())
  if (/triggered|armed at/i.test(await pill())) return // already armed and fresh
  await sec.getByRole('button', { name: 'Test it now' }).click()
  await waitToast(/Guard armed/)
})

await step('Guard fires (keeper, or fire it yourself)', async () => {
  const sec = page.locator('section[aria-labelledby="guard-h"]')
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    const t = await sec.locator('.pill').first().innerText()
    if (/not armed/i.test(t)) return // fired: the order is gone
    const fire = sec.getByRole('button', { name: /Fire it yourself/ })
    if (Date.now() > until - 60_000 && await fire.isVisible().catch(() => false)) { await fire.click(); await page.waitForTimeout(15_000) }
    await page.waitForTimeout(4000)
  }
  throw new Error('Guard still armed')
})

await step('Leverage up +0.25x', async () => {
  const sec = page.locator('section[aria-labelledby="manage-h"]')
  await sec.getByRole('button', { name: '+0.25×' }).click()
  await sec.getByRole('button', { name: /Leverage up in one transaction/ }).click()
  await waitToast(/Leverage increased/)
  await page.waitForTimeout(12_000)
})

await step('Deleverage 10%', async () => {
  const sec = page.locator('section[aria-labelledby="manage-h"]')
  await sec.getByRole('button', { name: 'Repay 10%' }).click()
  await sec.getByRole('button', { name: /Deleverage in one transaction/ }).click()
  await waitToast(/Leverage reduced/)
  await page.waitForTimeout(12_000)
})

await step('Unwind', async () => {
  const sec = page.locator('section[aria-labelledby="manage-h"]')
  await sec.getByRole('button', { name: /Unwind in one transaction/ }).click()
  await waitToast(/Position closed/)
  await waitText(/Build a position/, 60_000)
})

console.log(JSON.stringify(log))
await browser.close()
