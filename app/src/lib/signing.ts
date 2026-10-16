import type { Address } from 'viem'
import { ADDR, mezoTestnet } from './chain'

/**
 * EIP-712 messages for MUSD's BorrowerOperationsSignatures.
 * Field order and names match the contract's typehashes exactly; the trove always belongs to
 * `borrower` (the user) and Coil is only the `recipient` of what it needs to settle the flash swap.
 */
const domain = {
  name: 'BorrowerOperationsSignatures',
  version: '1',
  chainId: mezoTestnet.id,
  verifyingContract: ADDR.borrowerOpsSignatures,
} as const

export function openTroveTypedData(p: {
  assetAmount: bigint
  debtAmount: bigint
  borrower: Address
  recipient: Address
  nonce: bigint
  deadline: bigint
}) {
  return {
    domain,
    primaryType: 'OpenTrove' as const,
    types: {
      OpenTrove: [
        { name: 'assetAmount', type: 'uint256' },
        { name: 'debtAmount', type: 'uint256' },
        { name: 'borrower', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: p,
  }
}

export function closeTroveTypedData(p: { borrower: Address; recipient: Address; nonce: bigint; deadline: bigint }) {
  return {
    domain,
    primaryType: 'CloseTrove' as const,
    types: {
      CloseTrove: [
        { name: 'borrower', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: p,
  }
}

export function adjustTroveTypedData(p: {
  collWithdrawal: bigint
  debtChange: bigint
  isDebtIncrease: boolean
  assetAmount: bigint
  borrower: Address
  recipient: Address
  nonce: bigint
  deadline: bigint
}) {
  return {
    domain,
    primaryType: 'AdjustTrove' as const,
    types: {
      AdjustTrove: [
        { name: 'collWithdrawal', type: 'uint256' },
        { name: 'debtChange', type: 'uint256' },
        { name: 'isDebtIncrease', type: 'bool' },
        { name: 'assetAmount', type: 'uint256' },
        { name: 'borrower', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: p,
  }
}

export const deadlineIn = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds)
