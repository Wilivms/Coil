import { createPublicClient, http, formatEther, pad } from 'viem'
const pub = createPublicClient({ transport: http('https://rpc.test.mezo.org', { retryCount: 5 }) })
const A = '0x056053003138f87a3ad010b5e79429bacc0070e2'
const head = await pub.getBlockNumber()
const logs = await pub.request({ method: 'eth_getLogs', params: [{ address: '0x17e056ef7e076Fbcb806dF9916552A26Da527F03', fromBlock: '0x' + (head - 9000n).toString(16), toBlock: '0x' + head.toString(16), topics: [null, pad(A)] }] })
const first = BigInt(logs[0].blockNumber), last = BigInt(logs[logs.length - 1].blockNumber)
console.log('router blocks', first, last)
let out = 0
for (let n = first - 300n; n <= head && out < 8; n += 1n) {
  let b; for (let i = 0; i < 4 && !b; i++) { try { b = await pub.getBlock({ blockNumber: n, includeTransactions: true }) } catch {} }
  if (!b) { console.log('skip', n); continue }
  for (const t of b.transactions) if (t.from.toLowerCase() === A || (t.to || '').toLowerCase() === A) {
    console.log(new Date(Number(b.timestamp) * 1000).toISOString().slice(11, 19), t.from.toLowerCase() === A ? 'OUT n' + t.nonce : 'IN ', 'to', t.to, t.input.slice(0, 10), formatEther(t.value), t.hash)
    if (t.from.toLowerCase() === A) out++ }
}
