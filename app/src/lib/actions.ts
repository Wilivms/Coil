import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { zeroAddress, type Address, type Hash } from 'viem'
import { ADDR, COIL_ROUTER, mezoTestnet } from './chain'
import { bosAbi, coilRouterAbi, hintHelpersAbi, sortedTrovesAbi } from './abis'
import { client } from './live'
import { adjustTroveTypedData, closeTroveTypedData, deadlineIn, openTroveTypedData } from './signing'
import type { GuardPlan, OpenPlan } from './math'
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
      await Promise.all(['trove', 'guard', 'market', 'radar', 'activity'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
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

  return {
    ready,
    step,
    busy,

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
          args: [trigger, g.withdraw, g.repay, bountyBps, deadline, signature],
        })
      }, 'Guard armed'),

    disarmGuard: () =>
      run('Disarm Guard', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'disarmGuard',
        })
      }, 'Guard disarmed'),
  }
}
