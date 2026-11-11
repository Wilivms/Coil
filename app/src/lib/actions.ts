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
import { buyBtcTolerance, sellBtcTolerance, unwindTolerance } from './tolerance'
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

  /**
   * Wait for a receipt, riding out the RPC's transient errors (Mezo testnet answers "method handler
   * crashed" now and then): a transaction that went through must never show as failed.
   */
  async function confirm(hash: Hash) {
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      try {
        const r = await client.getTransactionReceipt({ hash })
        if (r) return r
      } catch { /* not mined yet, or a transient RPC error */ }
      await new Promise((res) => setTimeout(res, 2000))
    }
    return null
  }

  async function run(label: string, fn: (user: Address) => Promise<Hash>, success: string) {
    if (!address || !wallet) return toast.push({ kind: 'err', title: 'Connect a wallet first' })
    if (!COIL_ROUTER) return toast.push({ kind: 'err', title: 'Router not deployed', body: 'Deploy CoilRouter and set VITE_COIL_ROUTER.' })
    setBusy(label)
    try {
      if (chainId !== mezoTestnet.id) await switchChainAsync({ chainId: mezoTestnet.id })
      const hash = await fn(address)
      setStep('confirm')
      const receipt = await confirm(hash)
      if (!receipt) {
        // sent, but the RPC could not confirm it in time: never report a failure we can't see
        setStep('done')
        toast.push({ kind: 'ok', title: `${label}: sent`, body: 'Mezo has not confirmed it yet; it will show here once it does.', tx: hash })
        return
      }
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
        const [[upper, lower], dev] = await Promise.all([insertHints(collAfter, debtAfter), buyBtcTolerance(addColl)])
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'relever',
          args: [addColl, debtIncrease, upper, lower, signature, refinanceSig, deadline, 0n, dev],
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
        const [nonce, [upper, lower], value, dev] = await Promise.all([
          nonceOf(user), insertHints(plan.totalColl, plan.compositeDebt), feeAdjustedValue(plan.deposit), buyBtcTolerance(plan.flashBtc),
        ])
        const deadline = deadlineIn(20 * 60)
        const signature = await wallet!.signTypedData({
          account: user,
          ...openTroveTypedData({ assetAmount: plan.totalColl, debtAmount: plan.debtAmount, borrower: user, recipient: COIL_ROUTER!, nonce, deadline }),
        })
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'coil',
          args: [plan.totalColl, plan.debtAmount, upper, lower, signature, deadline, dev], value,
        })
      }, 'Position open'),

    unwind: (minBtcOut: bigint) =>
      run('Unwind', async (user) => {
        setStep('sign')
        const [nonce, dev] = await Promise.all([nonceOf(user), unwindTolerance(user)])
        const deadline = deadlineIn(20 * 60)
        const signature = await wallet!.signTypedData({
          account: user, ...closeTroveTypedData({ borrower: user, recipient: COIL_ROUTER!, nonce, deadline }),
        })
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'unwind',
          args: [signature, deadline, minBtcOut, dev],
        })
      }, 'Position closed'),

    deleverage: (withdraw: bigint, repay: bigint, collAfter: bigint, debtAfter: bigint) =>
      run('Deleverage', async (user) => {
        setStep('sign')
        const [nonce, [upper, lower], dev] = await Promise.all([nonceOf(user), insertHints(collAfter, debtAfter), sellBtcTolerance(repay)])
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
          args: [withdraw, repay, upper, lower, signature, deadline, 0n, dev],
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

    /** Anyone may fire a triggered protection and take its bounty; the contract checks the trigger itself. */
    fire: (kind: 'Guard' | 'Shield' | 'Recoil', owner: Address) =>
      run(`Fire ${kind}`, async (user) => {
        setStep('send')
        // where the trove lands in SortedTroves after the fire, so MUSD doesn't walk the whole list
        const dc = await client.readContract({ address: ADDR.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl', args: [owner] })
        let [coll, debt] = [dc[0], dc[1]]
        if (kind === 'Shield') {
          const o = await client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'shieldOf', args: [owner] })
          debt -= o.repayAmount < debt ? o.repayAmount : 0n
        } else if (kind === 'Guard') {
          const o = await client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'guardOf', args: [owner] })
          coll -= o.collWithdrawal; debt -= o.debtRepay < debt ? o.debtRepay : 0n
        } else {
          const o = await client.readContract({ address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'recoilOf', args: [owner] })
          coll += o.addColl; debt += (o.debtIncrease * 1001n) / 1000n
        }
        const [upper, lower] = await insertHints(coll, debt)
        const common = { account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi } as const
        if (kind === 'Shield') return wallet!.writeContract({ ...common, functionName: 'fireShield', args: [owner, upper, lower, 200n] })
        if (kind === 'Guard') return wallet!.writeContract({ ...common, functionName: 'fireGuard', args: [owner, upper, lower] })
        return wallet!.writeContract({ ...common, functionName: 'fireRecoil', args: [owner, upper, lower] })
      }, 'Fired, the bounty is yours'),

    disarmGuard: () =>
      run('Disarm Guard', async (user) => {
        setStep('send')
        return wallet!.writeContract({
          account: user, chain: mezoTestnet, address: COIL_ROUTER!, abi: coilRouterAbi, functionName: 'disarmGuard',
        })
      }, 'Guard disarmed'),
  }
}
