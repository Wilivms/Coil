import { defineChain, getAddress, type Address } from 'viem'

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
  savings: '0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16', // MUSDSavingsRate (sMUSD)
  collSurplusPool: '0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9',
} as const satisfies Record<string, Address>

/** CoilRouter v1 (Wave 1), deployed 16 Oct 2026 at block 16188308. Kept for its on-chain history. */
export const ROUTER_V1 = '0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16' as Address
export const ROUTER_V1_BLOCK = 16_188_308n

/** CoilRouter v2 (Wave 2, first half), deployed 4 Nov 2026 at block 16558220. Kept for its history (first Guard fire). */
export const ROUTER_V2 = '0xA9aDbE2e3DDFbD3795Add019c8EA64a950777a92' as Address
export const ROUTER_V2_BLOCK = 16_558_220n

/** CoilRouter v3 (Wave 2): relever, Recoil, gauge incentives; the full on-chain E2E ran on it. Kept for its history. */
export const ROUTER_V3 = getAddress('0x7b3D480207A95Ff14Ec89a0B9dA4dD435c4B6Ac4'.toLowerCase())
export const ROUTER_V3_BLOCK = 16_559_650n

/** CoilRouter v4 (Wave 2, current): v3 plus the borrower's own PriceFeed tolerance on the swaps they send.
 *  Source-verified. VITE_COIL_ROUTER overrides it. */
const DEPLOYED_ROUTER: string = '0x17e056ef7e076Fbcb806dF9916552A26Da527F03'
export const ROUTER_V4_BLOCK = 16_701_916n
/** CoilLens for v4: read-only status views (verified). */
export const COIL_LENS = getAddress('0xa82154DD7bf08840F4D9d97a44999C4D4F76d8f5'.toLowerCase())
/** MUSD/BTC gauge incentive contract that receives Coil's incentives (PoolsVoter 0x263F…5F0D). */
export const GAUGE_INCENTIVES = '0x75b6B35Fc78826A0B7E1f9c08bb7d84bd70D0ee1' as Address
const envRouter = (import.meta.env.VITE_COIL_ROUTER ?? '').trim() || DEPLOYED_ROUTER
// getAddress on the lowercased value: a mistyped checksum can never break the app again
export const COIL_ROUTER: Address | null = /^0x[0-9a-fA-F]{40}$/.test(envRouter) ? getAddress(envRouter.toLowerCase()) : null

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
