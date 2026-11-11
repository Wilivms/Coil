import { describe, expect, it } from 'vitest'
import { hashTypedData } from 'viem'
import { adjustTroveTypedData, closeTroveTypedData, openTroveTypedData, repayTypedData } from '../lib/signing'

// The same digests are asserted on the Solidity side (contracts/test/SignatureCompat.t.sol), computed
// the way MUSD's BorrowerOperationsSignatures does. If the app's field order or domain drifts, both fail.
const U = '0x1111111111111111111111111111111111111111'
const R = '0x2222222222222222222222222222222222222222'
const DEADLINE = 1792150000n
const e18 = 10n ** 18n

describe('EIP-712 digests equal MUSD BorrowerOperationsSignatures', () => {
  it('OpenTrove', () => {
    expect(hashTypedData(openTroveTypedData({ assetAmount: 3n * e18, debtAmount: 165_000n * e18, borrower: U, recipient: R, nonce: 4n, deadline: DEADLINE })))
      .toBe('0xfad0d703634c34e16a6d0d10f9fd5b8dbac2d3bdf6964aca3ba0e3c0e9001b1e')
  })
  it('AdjustTrove', () => {
    expect(hashTypedData(adjustTroveTypedData({ collWithdrawal: e18 / 10n, debtChange: 8000n * e18, isDebtIncrease: false, assetAmount: 0n, borrower: U, recipient: R, nonce: 5n, deadline: DEADLINE })))
      .toBe('0x078d1f51f1e572a0ce913cfbd8b96bf1677bed3be6ac3751d2d263948e0444eb')
  })
  it('CloseTrove', () => {
    expect(hashTypedData(closeTroveTypedData({ borrower: U, recipient: R, nonce: 6n, deadline: DEADLINE })))
      .toBe('0xd8efd638ff917b68922334a5fdf51f790d59a41a4509297c363f8f0e59105b29')
  })
  it('RepayMUSD (Shield)', () => {
    expect(hashTypedData(repayTypedData({ amount: 1234n * e18, borrower: U, nonce: 7n, deadline: DEADLINE })))
      .toBe('0xc3449dc4b7dc83605e95db3c343a8ad324a0a7780d5e51f122d89ca162c3ccb0')
  })
})
