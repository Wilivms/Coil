/**
 * Insert hints for MUSD's SortedTroves, so a fire doesn't walk the whole list (a hintless
 * fireShield used 4.7M gas on testnet; with hints it is a fraction of that).
 * The trove's position after the operation is predicted from the signed order, like the app does.
 */
import { parseAbi } from 'viem'

const TM = '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0'
const SORTED = '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA'
const HINTS = '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6'
const ZERO = '0x0000000000000000000000000000000000000000'

const abi = parseAbi([
  'function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingColl, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getApproxHint(uint256 CR, uint256 numTrials, uint256 inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)',
  'function findInsertPosition(uint256 NICR, address prevId, address nextId) view returns (address, address)',
  'function guardOf(address) view returns ((uint128 triggerPrice, uint128 collWithdrawal, uint128 debtRepay, uint128 minBtcOut, uint64 deadline, uint16 bountyBps, uint64 nonce, bytes signature))',
  'function shieldOf(address) view returns ((uint128 repayAmount, uint128 triggerPrice, uint128 maxDebtAhead, uint128 bountyMusd, uint64 deadline, uint64 nonce, bytes signature))',
  'function recoilOf(address) view returns ((uint128 triggerIcr, uint128 addColl, uint128 debtIncrease, uint64 deadline, uint16 bountyBps, uint64 nonce, bytes signature, bytes refinanceSig))',
])

export async function hintsFor(pub, nicrColl, nicrDebt) {
  if (nicrDebt <= 0n) return [ZERO, ZERO]
  try {
    const nicr = (nicrColl * 10n ** 20n) / nicrDebt
    const [approx] = await pub.readContract({ address: HINTS, abi, functionName: 'getApproxHint', args: [nicr, 15n, BigInt(Math.floor(Math.random() * 1e9))] })
    return await pub.readContract({ address: SORTED, abi, functionName: 'findInsertPosition', args: [nicr, approx, approx] })
  } catch {
    return [ZERO, ZERO] // still valid, just more gas
  }
}

/** Hints for firing `kind` ('guard' | 'shield' | 'recoil') on `user`'s trove through `router`. */
export async function fireHints(pub, router, kind, user) {
  try {
    const t = await pub.readContract({ address: TM, abi, functionName: 'getEntireDebtAndColl', args: [user] })
    let coll = t[0], debt = t[1]
    if (kind === 'guard') {
      const o = await pub.readContract({ address: router, abi, functionName: 'guardOf', args: [user] })
      coll -= o.collWithdrawal; debt = o.debtRepay < debt ? debt - o.debtRepay : debt
    } else if (kind === 'shield') {
      const o = await pub.readContract({ address: router, abi, functionName: 'shieldOf', args: [user] })
      debt = o.repayAmount < debt ? debt - o.repayAmount : debt
    } else {
      const o = await pub.readContract({ address: router, abi, functionName: 'recoilOf', args: [user] })
      coll += o.addColl; debt += (o.debtIncrease * 1001n) / 1000n
    }
    return hintsFor(pub, coll, debt)
  } catch {
    return [ZERO, ZERO]
  }
}
