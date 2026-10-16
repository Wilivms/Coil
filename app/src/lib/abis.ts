import { parseAbi } from 'viem'

export const coilRouterAbi = parseAbi([
  'function coil(uint256 totalColl, uint256 debtAmount, address upperHint, address lowerHint, bytes signature, uint256 deadline) payable returns (uint256)',
  'function unwind(bytes signature, uint256 deadline, uint256 minBtcOut) returns (uint256)',
  'function deleverage(uint256 collWithdrawal, uint256 debtRepay, address upperHint, address lowerHint, bytes signature, uint256 deadline, uint256 minBtcOut) returns (uint256)',
  'function armGuard(uint128 triggerPrice, uint128 collWithdrawal, uint128 debtRepay, uint16 bountyBps, uint64 deadline, bytes signature)',
  'function disarmGuard()',
  'function fireGuard(address user, address upperHint, address lowerHint) returns (uint256)',
  'function guardOf(address user) view returns ((uint128 triggerPrice, uint128 collWithdrawal, uint128 debtRepay, uint64 deadline, uint16 bountyBps, uint64 nonce, bytes signature))',
  'function guardStatus(address user) view returns (bool armed, bool fresh, bool triggered)',
  'function closeAmount(address user) view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'event Coiled(address indexed user, uint256 deposit, uint256 totalColl, uint256 debtAmount, uint256 flashBtc, uint256 musdPaidToPool, uint256 musdRefund)',
  'event Unwound(address indexed user, uint256 musdRepaid, uint256 btcOut)',
  'event Delevered(address indexed user, uint256 collWithdrawn, uint256 debtRepaid, uint256 btcOut)',
  'event GuardArmed(address indexed user, uint256 triggerPrice, uint256 collWithdrawal, uint256 debtRepay, uint256 bountyBps, uint256 deadline)',
  'event GuardFired(address indexed user, address indexed keeper, uint256 price, uint256 btcToUser, uint256 bounty)',
])

export const troveManagerAbi = parseAbi([
  'function getEntireDebtAndColl(address borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getTroveStatus(address borrower) view returns (uint8)',
  'function getTroveInterestRate(address borrower) view returns (uint16)',
  'function getTroveOwnersCount() view returns (uint256)',
  'function getTroveFromTroveOwnersArray(uint256 index) view returns (address)',
  'function getTCR(uint256 price) view returns (uint256)',
  'function checkRecoveryMode(uint256 price) view returns (bool)',
])

export const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)'])

export const poolAbi = parseAbi([
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
])

export const poolFactoryAbi = parseAbi(['function getFee(address pool, bool stable) view returns (uint256)'])

export const bosAbi = parseAbi(['function getNonce(address user) view returns (uint256)'])

export const borrowerOpsAbi = parseAbi(['function minNetDebt() view returns (uint256)'])

export const interestRateManagerAbi = parseAbi(['function interestRate() view returns (uint16)'])

export const hintHelpersAbi = parseAbi([
  'function getApproxHint(uint256 CR, uint256 numTrials, uint256 inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)',
])

export const sortedTrovesAbi = parseAbi([
  'function findInsertPosition(uint256 NICR, address prevId, address nextId) view returns (address, address)',
  'function getSize() view returns (uint256)',
])

export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)'])
