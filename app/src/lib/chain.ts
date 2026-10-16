import { defineChain, type Address } from 'viem'

export const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.test.mezo.org'], webSocket: ['wss://rpc-ws.test.mezo.org'] },
  },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } },
  testnet: true,
})

/** Mezo testnet contracts (MUSD deployments from @mezo-org/musd-contracts, pools from mezo.org/docs). */
export const ADDR = {
  borrowerOpsSignatures: '0xD757e3646AF370b15f32EB557F0F8380Df7D639e',
  borrowerOps: '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  sortedTroves: '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA',
  hintHelpers: '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6',
  interestRateManager: '0xD4D6c36A592A2c5e86035A6bca1d57747a567f37',
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  btc: '0x7b7C000000000000000000000000000000000000',
  pool: '0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9', // MUSD/BTC volatile, token0 = MUSD
  poolFactory: '0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A',
} as const satisfies Record<string, Address>

const envRouter = (import.meta.env.VITE_COIL_ROUTER ?? '').trim()
/** CoilRouter address. Empty until you deploy (see contracts/script/Deploy.s.sol). */
export const COIL_ROUTER: Address | null = /^0x[0-9a-fA-F]{40}$/.test(envRouter) ? (envRouter as Address) : null

export const EXPLORER = 'https://explorer.test.mezo.org'
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`
export const explorerAddr = (a: string) => `${EXPLORER}/address/${a}`

/** Protocol constants read from the MUSD source (LiquityBase / BorrowerOperations). */
export const MUSD = {
  MCR: 1.1,
  CCR: 1.5,
  GAS_COMP: 200,
  BORROW_FEE: 0.001,
  REDEMPTION_FEE: 0.0075,
} as const
