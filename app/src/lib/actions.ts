import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { zeroAddress, type Address, type Hash } from 'viem'
import { ADDR, COIL_ROUTER, mezoTestnet, ROUTER_V2 } from './chain'
import { borrowerOpsAbi, bosAbi, coilRouterAbi, erc20Abi, hintHelpersAbi, interestRateManagerAbi, maxCapacityAbi, sortedTrovesAbi, troveManagerAbi } from './abis'
import { client } from './live'
import { adjustTroveTypedData, closeTroveTypedData, deadlineIn, openTroveTypedData, refinanceTypedData, repayTypedData } from './signing'
import type { GuardPlan, OpenPlan } from './math'
import { toWad } from './math'
import { explainError, useToast } from '../components/Toasts'

export type Step = 'idle' | 'sign' | 'send' | 'confirm' | 'done'

/** Sorted-list hints so MUSD inserts the trove without walking the whole list. */
export async function insertHints(coll: bigint, debt: bigint): Promise<[Address, Address]> {
  if (debt === 0n) return [zeroAddress, zeroAddress]
  const nicr = (coll * 10n ** 20n) / debt
  try {
    const [approx] = await client.readContract({
      address: ADDR.hintHelpers, abi: hintHelpersAbi, functionName: 'getApproxHint',
      args: [nicr, 15n, BigInt(Math.floor(Math.random() * 1e9))],
    })
    const [upper, lower] = await client.readContract({
      address: ADDR.sortedTroves, abi: sortedTrovesAbi, functionName: 'findInsertPosition', args: [nicr, approx, approx],
    })
    return [upper, lower]
  } catch {
    return [zeroAddress, zeroAddress] // valid, just more gas
  }
}

export function useCoilActions() {
  const { address, chainId } = useAccount()
  const { data: wallet } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()
  const qc = useQueryClient()
  const toast = useToast()
  const [step, setStep] = useState<Step>('idle')
  const [busy, setBusy] = useState<string | null>(null)

  const ready = !!address && !!wallet && !!COIL_ROUTER

  async function run(label: string, fn: (user: Address) => Promise<Hash>, success: string) {
    if (!address || !wallet) return toast.push({ kind: 'err', title: 'Connect a wallet first' })
    if (!COIL_ROUTER) return toast.push({ kind: 'err', title: 'Router not deployed', body: 'Deploy CoilRouter and set VITE_COIL_ROUTER.' })
    setBusy(label)
    try {
      if (chainId !== mezoTestnet.id) await switchChainAsync({ chainId: mezoTestnet.id })
      const hash = await fn(address)
      setStep('confirm')
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      setStep('done')
      toast.push({ kind: 'ok', title: success, tx: hash })
      await Promise.all(['trove', 'guard', 'market', 'radar', 'activity', 'reserve', 'shield', 'surplus', 'recoil'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
    } catch (e) {
      setStep('idle')
      toast.push({ kind: 'err', title: `${label} failed`, body: explainError(e) })
    } finally {
      setBusy(null)
      setTimeout(() => setStep('idle'), 2500)
    }
  }

  const nonceOf = (user: Address) =>
    client.readContract({ address: ADDR.borrowerOpsSignatures, abi: bosAbi, functionName: 'getNonce', args: [user] })

  async function feeAdjustedValue(deposit: bigint) {
    const fee = BigInt(await client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'feeBps' }))
    return fee === 0n ? deposit : (deposit * 10_000n + (10_000n - fee - 1n)) / (10_000n - fee)
  }

  /**
   * Signatures for a leverage-up: the AdjustTrove (debt increase, collateral in) and, when MUSD's
   * borrowing capacity is too small, a Refinance signed one nonce earlier that resets it.
   */
  async function releverSigs(user: Address, addColl: bigint, debtIncrease: bigint, deadline: bigint) {
    const [nonce, dc, cap] = await Promise.all([
      nonceOf(user),
      client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl', args: [user] }),
      client.readContract({ address: ADDR.troveManager, abi: maxCapacityAbi, functionName: 'getTroveMaxBorrowingCapacity', args: [user] }),
    ])
    const debtAfter = dc[1] + dc[2] + (debtIncrease * 1001n) / 1000n
    let refinanceSig: `0x${string}` = '0x'
    let n = nonce
    if (debtAfter > cap) {
      const rate = await client.readContract({ address: ADDR.interestRateManager, abi: interestRateManagerAbi, functionName: 'interestRate' })
      refinanceSig = await wallet!.signTypedData({
        account: user, ...refinanceTypedData({ borrower: user, interestRate: Number(rate), nonce: n, deadline }),
      })
      n += 1n
    }
    const signature = await wallet!.signTypedData({
      account: user,
      ...adjustTroveTypedData({
        collWithdrawal: 0n, debtChange: debtIncrease, isDebtIncrease: true, assetAmount: addColl, borrower: user,
        recipient: COIL_ROUTER!, nonce: n, deadline,
      }),
    })
    return { signature, refinanceSig, collAfter: dc[0] + addColl, debtAfter }
  }

  return {
    ready,
    step,
    busy,

    relever: (addColl: bigint, debtIncrease: bigint) =>
      run('Leverage up', async (user) => {
        setStep('sign')
        const deadline = deadlineIn(20 * 60)
        const { signature, refinanceSig, collAfter, debtAfter } = await releverSigs(user, addColl, debtIncrease, deadline)
        const [upper, lower] = await insertHints(collAfter, debtAfter)
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'relever',
          args: [addColl, debtIncrease, upper, lower, signature, refinanceSig, deadline, 0n],
        })
      }, 'Leverage increased'),

    armRecoil: (triggerIcr: number, addColl: bigint, debtIncrease: bigint, days: number) =>
      run('Arm Recoil', async (user) => {
        setStep('sign')
        const deadline = deadlineIn(days * 86_400)
        const { signature, refinanceSig } = await releverSigs(user, addColl, debtIncrease, deadline)
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'armRecoil',
          args: [toWad(triggerIcr), addColl, debtIncrease, 30, deadline, signature, refinanceSig],
        })
      }, 'Recoil armed'),

    disarmRecoil: () =>
      run('Disarm Recoil', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'disarmRecoil',
        })
      }, 'Recoil disarmed'),

    coil: (plan: OpenPlan) =>
      run('Coil', async (user) => {
        setStep('sign')
        const [nonce, [upper, lower], value] = await Promise.all([
          nonceOf(user), insertHints(plan.totalColl, plan.compositeDebt), feeAdjustedValue(plan.deposit),
        ])
        const deadline = deadlineIn(20 * 60)
        const signature = await wallet!.signTypedData({
          account: user,
          ...openTroveTypedData({ assetAmount: plan.totalColl, debtAmount: plan.debtAmount, borrower: user, recipient: COIL_ROUTER!, nonce, deadline }),
        })
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'coil',
          args: [plan.totalColl, plan.debtAmount, upper, lower, signature, deadline], value,
        })
      }, 'Position open'),

    unwind: (minBtcOut: bigint) =>
      run('Unwind', async (user) => {
        setStep('sign')
        const nonce = await nonceOf(user)
        const deadline = deadlineIn(20 * 60)
        const signature = await wallet!.signTypedData({
          account: user, ...closeTroveTypedData({ borrower: user, recipient: COIL_ROUTER!, nonce, deadline }),
        })
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'unwind',
          args: [signature, deadline, minBtcOut],
        })
      }, 'Position closed'),

    deleverage: (withdraw: bigint, repay: bigint, collAfter: bigint, debtAfter: bigint) =>
      run('Deleverage', async (user) => {
        setStep('sign')
        const [nonce, [upper, lower]] = await Promise.all([nonceOf(user), insertHints(collAfter, debtAfter)])
        const deadline = deadlineIn(20 * 60)
        const signature = await wallet!.signTypedData({
          account: user,
          ...adjustTroveTypedData({
            collWithdrawal: withdraw, debtChange: repay, isDebtIncrease: false, assetAmount: 0n, borrower: user,
            recipient: COIL_ROUTER!, nonce, deadline,
          }),
        })
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'deleverage',
          args: [withdraw, repay, upper, lower, signature, deadline, 0n],
        })
      }, 'Leverage reduced'),

    armGuard: (g: GuardPlan, bountyBps: number, days: number) =>
      run('Arm Guard', async (user) => {
        setStep('sign')
        const nonce = await nonceOf(user)
        const deadline = deadlineIn(days * 86_400)
        const signature = await wallet!.signTypedData({
          account: user,
          ...adjustTroveTypedData({
            collWithdrawal: g.withdraw, debtChange: g.repay, isDebtIncrease: false, assetAmount: 0n, borrower: user,
            recipient: COIL_ROUTER!, nonce, deadline,
          }),
        })
        setStep('send')
        const trigger = BigInt(Math.round(g.trigger)) * 10n ** 18n
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'armGuard',
          args: [trigger, g.withdraw, g.repay, g.minBtcOut, bountyBps, deadline, signature],
        })
      }, 'Guard armed'),

    depositReserve: (amount: bigint) =>
      run('Fund Reserve', async (user) => {
        const allowance = await client.readContract({
          address: ADDR.musd, abi: erc20Abi, functionName: 'allowance', args: [user, COIL_ROUTER!],
        })
        if (allowance < amount) {
          setStep('sign')
          const h = await wallet!.writeContract({
            account: user, chain: mezoTestnet, address: ADDR.musd, abi: erc20Abi, functionName: 'approve',
            args: [COIL_ROUTER!, amount],
          })
          await client.waitForTransactionReceipt({ hash: h })
        }
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'depositReserve',
          args: [amount],
        })
      }, 'Reserve funded, earning sMUSD yield'),

    withdrawLegacyReserve: () =>
      run('Withdraw v2 Reserve', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: ROUTER_V2, abi: coilRouterAbi, functionName: 'withdrawReserve',
          args: [(1n << 256n) - 1n],
        })
      }, 'v2 Reserve back in your wallet'),

    withdrawReserve: (amount: bigint) =>
      run('Withdraw Reserve', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'withdrawReserve',
          args: [amount],
        })
      }, 'MUSD back in your wallet'),

    armShield: (repay: bigint, triggerUsd: number, maxDebtAheadMusd: number, days: number) =>
      run('Arm Shield', async (user) => {
        setStep('sign')
        const nonce = await nonceOf(user)
        const deadline = deadlineIn(days * 86_400)
        const signature = await wallet!.signTypedData({
          account: user, ...repayTypedData({ amount: repay, borrower: user, nonce, deadline }),
        })
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'armShield',
          args: [repay, triggerUsd > 0 ? toWad(Math.round(triggerUsd)) : 0n, toWad(maxDebtAheadMusd), toWad(5), deadline, signature],
        })
      }, 'Shield armed'),

    disarmShield: () =>
      run('Disarm Shield', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'disarmShield',
        })
      }, 'Shield disarmed'),

    claimCollateral: () =>
      run('Claim BTC', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: ADDR.borrowerOps, abi: borrowerOpsAbi, functionName: 'claimCollateral',
        })
      }, 'Leftover BTC claimed'),

    disarmGuard: () =>
      run('Disarm Guard', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'disarmGuard',
        })
      }, 'Guard disarmed'),
  }
}
