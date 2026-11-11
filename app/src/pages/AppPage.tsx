import { useEffect, useMemo, useState } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther, isAddress, parseEther } from 'viem'
import { COIL_ROUTER, explorerAddr, explorerTx, MUSD, ROUTER_V1 } from '../lib/chain'
import { DEPLOY_TX, useActivity, type ActivityItem } from '../lib/activity'
import {
  useBtcHistory, useGuard, useMarket, useRadar, useRecoil, useReserve, useShield, useSurplus, useTrove, redemptionShield, type MarketState,
} from '../lib/live'
import {
  amountIn, fromWad, maxLeverage, planClose, planGuard, planOpen, planShield, releverPlan, toWad, WAD, type OpenPlan,
} from '../lib/math'
import { historicalTouchRate, realizedVol, touchProbability } from '../lib/risk'
import { fmtBtc, fmtCompact, fmtNum, fmtPct, fmtUsd, shortAddr } from '../lib/format'
import { useTweened } from '../lib/motion'
import { useCoilActions, type Step } from '../lib/actions'
import { DEFAULT_DEVIATION_BPS, poolGap } from '../lib/tolerance'
import { buyBtcCosts, sellBtcCosts, totalCost, type CostRow } from '../lib/costs'
import { FlowGraph } from '../components/FlowGraph'
import { Fan } from '../components/Fan'
import { Gauge, RadarStrip, ReplayChart, type ReplayWindow } from '../components/Instruments'

const EXAMPLE: MarketState = {
  price: 82_089n * WAD, reserveMusd: 102_589_167n * WAD, reserveBtc: 1_302n * WAD, feeBps: 30n, minNetDebt: 1800n * WAD,
  interestBps: 100, tcr: 2.95, recoveryMode: false, troves: 247, block: 0n, updatedAt: 0, coilFeeBps: 0, incentiveBps: 5,
}

type Position = { coll: number; debt: number; source: 'live' | 'preview' }

/** `#/app?address=0x…` shows any wallet's position read-only (no wallet needed). */
function viewAddress(): `0x${string}` | undefined {
  const q = window.location.hash.split('?')[1] ?? window.location.search.slice(1)
  const a = new URLSearchParams(q).get('address')
  return a && isAddress(a) ? (a as `0x${string}`) : undefined
}

export function AppPage() {
  const { address: wallet } = useAccount()
  const [view, setView] = useState(viewAddress)
  useEffect(() => {
    const on = () => setView(viewAddress())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const viewing = !!view && view.toLowerCase() !== wallet?.toLowerCase()
  const address = view ?? wallet
  const marketQ = useMarket()
  const m = marketQ.data ?? EXAMPLE
  const price = fromWad(m.price)
  const troveQ = useTrove(address)
  const trove = troveQ.data?.exists ? troveQ.data : undefined
  const guardQ = useGuard(trove ? address : undefined)
  const radarQ = useRadar(marketQ.data?.price)
  const reserveQ = useReserve(address)
  const shieldQ = useShield(trove ? address : undefined)
  const surplusQ = useSurplus(address)
  const recoilQ = useRecoil(trove ? address : undefined)
  const hist = useBtcHistory()
  const own = useCoilActions()
  // viewing someone else's trove: no signing on their behalf; firing a due protection stays open to anyone
  const actions = viewing ? { ...own, ready: false } : own
  const fire = (kind: 'Guard' | 'Shield' | 'Recoil') => address && own.fire(kind, address)
  const fireReady = own.ready

  const [depositStr, setDepositStr] = useState('0.05')
  const deposit = useMemo(() => {
    try {
      const v = parseEther((depositStr || '0').replace(',', '.'))
      return v > 0n ? v : 0n
    } catch {
      return 0n
    }
  }, [depositStr])
  const maxLev = useMemo(() => Math.max(1.1, Math.floor(maxLeverage(m, deposit > 0n ? deposit : WAD / 20n) * 20) / 20), [m, deposit])
  const [lev, setLev] = useState(3)
  useEffect(() => { if (lev > maxLev) setLev(maxLev) }, [maxLev, lev])
  const plan = useMemo(() => planOpen(m, deposit, lev), [m, deposit, lev])

  const position: Position | null = trove
    ? { coll: fromWad(trove.coll), debt: fromWad(trove.debt), source: 'live' }
    : plan.status !== 'empty' && plan.status !== 'no-liquidity'
      ? { coll: fromWad(plan.totalColl), debt: fromWad(plan.compositeDebt), source: 'preview' }
      : null

  const cr = position ? (position.coll * price) / position.debt : Infinity
  const liq = position ? (MUSD.MCR * position.debt) / position.coll : 0

  const histVol = hist.data ? realizedVol(hist.data.closes, hist.data.stepDays === 1 ? 30 : 8, hist.data.stepDays) : 0.5
  const [volOverride, setVolOverride] = useState<number | null>(null)
  const vol = volOverride ?? histVol

  const [trigger, setTrigger] = useState<number | null>(null)
  const triggerLo = liq * 1.03
  const triggerHi = price * 0.99
  const triggerV = trigger === null || trigger < triggerLo || trigger > triggerHi ? liq + (price - liq) * 0.4 : trigger

  return (
    <main className="app">
      <h1 className="sr-only">Coil app: open, protect and close a leveraged MUSD trove</h1>
      <div className="wrap">
        <MarketBar m={m} live={!!marketQ.data} error={marketQ.isError} />
        {view && (
          <p className="note" style={{ marginTop: 16 }}>
            Read-only view of <a className="mono" href={explorerAddr(view)} target="_blank" rel="noreferrer">{shortAddr(view)} ↗</a>: its trove, protections and history, live from Mezo testnet.
            {viewing ? ' Signing is off; anyone can still fire a protection that is due.' : ''} <a href="#/app">Back to your wallet</a>
          </p>
        )}
        <div className="app__grid" style={{ marginTop: 24 }}>
          <div className="stack">
            {!!surplusQ.data && surplusQ.data > 0n && (
              <section className="panel">
                <div className="panel__h"><h2>BTC to claim</h2><span className="pill" data-s="watch">Trove closed by MUSD</span></div>
                <div className="panel__b">
                  <p className="field__hint" style={{ margin: 0 }}>
                    A redemption or a Recovery Mode liquidation closed your trove and left {fmtBtc(fromWad(surplusQ.data), 5)} BTC in MUSD's surplus pool. It is yours: claim it in one transaction.
                  </p>
                  <button className="btn btn--block" disabled={!!actions.busy || !actions.ready} onClick={() => actions.claimCollateral()}>
                    {actions.busy === 'Claim BTC' ? 'Working…' : `Claim ${fmtBtc(fromWad(surplusQ.data), 5)} BTC`}
                  </button>
                </div>
              </section>
            )}
            {trove ? (
              <ManagePanel m={m} trove={{ coll: trove.coll, debt: trove.debt }} actions={actions} />
            ) : (
              <BuildPanel
                m={m} plan={plan} lev={lev} setLev={setLev} maxLev={maxLev} depositStr={depositStr}
                setDepositStr={setDepositStr} actions={actions}
              />
            )}
          </div>
          <div className="stack">
            {!trove && (
              <FlowGraph
                title={`coil(${fmtBtc(fromWad(plan.deposit), 3)} BTC, ${lev.toFixed(2)}×)`}
                pulseKey={`${lev}-${depositStr}`}
                nodes={[
                  { tag: 'Input', title: 'Your BTC', value: `${fmtBtc(fromWad(plan.deposit), 4)} BTC`, sub: fmtUsd(fromWad(plan.deposit) * price), fn: 'CoilRouter.coil{value}' },
                  { tag: 'Flash swap', title: 'Borrow BTC from the pool', value: `+${fmtBtc(fromWad(plan.flashBtc), 4)} BTC`, sub: `at ${fmtUsd(plan.poolPrice || 0)} · impact ${fmtPct(plan.priceImpact, 2)}`, fn: 'Pool.swap → hook()' },
                  { tag: 'Your trove', title: 'Open it in your name', value: `${fmtBtc(fromWad(plan.totalColl), 4)} BTC`, sub: `${fmtNum(fromWad(plan.compositeDebt))} MUSD debt`, fn: 'openTroveWithSignature' },
                  { tag: 'Settle', title: 'Repay the pool', value: `${fmtNum(fromWad(plan.musdIn))} MUSD`, sub: `${fmtNum(fromWad(plan.refund), 0)} MUSD back to you`, fn: 'MUSD.transfer(pool)' },
                ]}
              />
            )}
            <PositionPanel position={position} cr={cr} liq={liq} price={price} trove={!!trove} interestBps={trove?.interestBps ?? m.interestBps}
              guardCr={guardQ.data?.armed ? (position ? (position.coll * fromWad(guardQ.data.triggerPrice)) / position.debt : undefined) : undefined} />
            {position && (
              <RiskPanel price={price} liq={liq} vol={vol} histVol={histVol} setVol={setVolOverride} volOverride={volOverride}
                closes={hist.data?.closes} stepDays={hist.data?.stepDays ?? 1} source={hist.data?.source} trigger={triggerV} />
            )}
            {position && <RadarPanel radar={radarQ.data} loading={radarQ.isLoading} cr={cr} self={address} />}
            {position && (
              <GuardPanel m={m} position={position} trigger={triggerV} setTrigger={setTrigger} lo={triggerLo} hi={triggerHi}
                live={!!trove} guard={guardQ.data} actions={actions} fire={fire} fireReady={fireReady} />
            )}
            {position && (
              <RecoilPanel m={m} position={position} live={!!trove} recoil={recoilQ.data} actions={actions} fire={fire} fireReady={fireReady} />
            )}
            {position && (
              <ShieldPanel m={m} position={position} live={!!trove} trigger={triggerV} reserve={reserveQ.data}
                shield={shieldQ.data} actions={actions} fire={fire} fireReady={fireReady} />
            )}
            {position && hist.data && (
              <ReplayPanel closes={hist.data.closes} startDay={hist.data.startDay} stepDays={hist.data.stepDays}
                leverage={trove ? (position.coll * price) / (position.coll * price - position.debt) : lev} interestBps={m.interestBps} source={hist.data.source} />
            )}
            <ActivityPanel self={address} />
          </div>
        </div>
      </div>
    </main>
  )
}

/* ------------------------------------------------------------------ market */

function MarketBar({ m, live, error }: { m: MarketState; live: boolean; error: boolean }) {
  const p = useTweened(fromWad(m.price))
  const cells: [string, string, string?][] = [
    ['BTC · MUSD oracle', fmtUsd(p)],
    ['Pool depth', `${fmtCompact(fromWad(m.reserveBtc))} BTC`],
    ['Fixed rate', `${(m.interestBps / 100).toFixed(2)}%`],
    ['System ratio', fmtPct(m.tcr, 0), m.recoveryMode ? 'Recovery mode' : undefined],
    ['Troves', String(m.troves)],
    ['Block', live ? '#' + m.block.toString() : error ? 'RPC unreachable' : 'Loading'],
  ]
  return (
    <div className="panel">
      <div className="strip__in">
        {cells.map(([k, v, warn], i) => (
          <div className="strip__cell" key={k}>
            <span className="mono">{i === 0 && <span className={'dot' + (live ? '' : ' dot--off')} />}{k}</span>
            <span className={'strip__v' + (live ? '' : ' faint')}>{v}</span>
            {warn && <span className="pill" data-s="danger">{warn}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ build */

const STATUS_COPY: Record<OpenPlan['status'], string> = {
  ok: 'Ready',
  tight: 'Under 115%',
  'below-mcr': 'Under 110%',
  'below-min-debt': 'Debt too small',
  'no-liquidity': 'Too large for the pool',
  empty: 'Enter an amount',
}

function BuildPanel({ m, plan, lev, setLev, maxLev, depositStr, setDepositStr, actions }: {
  m: MarketState
  plan: OpenPlan
  lev: number
  setLev: (v: number) => void
  maxLev: number
  depositStr: string
  setDepositStr: (v: string) => void
  actions: ReturnType<typeof useCoilActions>
}) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const bal = useBalance({ address, query: { refetchInterval: 20_000 } })
  const price = fromWad(m.price)
  const debtShown = useTweened(fromWad(plan.compositeDebt))
  // how far the pool sits from MUSD's oracle, plus this trade's own impact
  const gap = poolGap(m.reserveMusd, m.reserveBtc, m.price)
  const tradeGap = gap + (plan.priceImpact || 0)
  const wide = tradeGap * 10_000 + 75 > DEFAULT_DEVIATION_BPS
  const levPct = ((lev - 1.1) / (8 - 1.1)) * 100
  const maxPct = ((maxLev - 1.1) / (8 - 1.1)) * 100
  const short = bal.data && plan.deposit > bal.data.value
  const canGo = plan.status === 'ok' && actions.ready && !short && !m.recoveryMode

  let cta = 'Sign and coil'
  if (!isConnected) cta = 'Connect a wallet'
  else if (!COIL_ROUTER) cta = 'Router not deployed yet'
  else if (short) cta = 'Not enough BTC'
  else if (plan.status !== 'ok') cta = STATUS_COPY[plan.status]

  return (
    <section className="panel panel--sticky" aria-labelledby="build-h">
      <div className="panel__h">
        <h2 id="build-h">Build a position</h2>
        <span className="pill" data-s={plan.status}>{STATUS_COPY[plan.status]}</span>
      </div>
      <div className="panel__b">
        <div className="field">
          <div className="field__top">
            <label className="mono" htmlFor="deposit">Deposit</label>
            {bal.data && (
              <button className="mini" onClick={() => setDepositStr(Number(formatEther((bal.data.value * 95n) / 100n)).toFixed(5))}>
                Wallet {Number(formatEther(bal.data.value)).toFixed(4)} BTC
              </button>
            )}
          </div>
          <div className="inp-wrap">
            <input id="deposit" className="inp" inputMode="decimal" value={depositStr} onChange={(e) => setDepositStr(e.target.value)} aria-describedby="deposit-usd" />
            <span className="unit mono">BTC</span>
          </div>
          <span id="deposit-usd" className="field__hint">{fmtUsd(fromWad(plan.deposit) * price)} at the MUSD oracle price</span>
        </div>

        <div className="field">
          <div className="field__top">
            <label className="mono" htmlFor="lev">Leverage</label>
            <span className="field__val muted">max {maxLev.toFixed(2)}× at ≥115%</span>
          </div>
          <div className="lev"><span className="lev__v">{lev.toFixed(2)}<em>×</em></span></div>
          <input
            id="lev" type="range" min={1.1} max={8} step={0.05} value={lev}
            style={{ ['--p' as string]: `${levPct}%`, ['--m' as string]: `${maxPct}%` }}
            onChange={(e) => setLev(Math.min(maxLev, Number(e.target.value)))}
          />
          <div className="ticks"><span>1.1×</span><span>2×</span><span>3×</span><span>5×</span><span>8×</span></div>
          <div className="inp-row">
            {[1.5, 2, 3, 4].filter((x) => x <= maxLev).map((x) => (
              <button key={x} className="mini" aria-pressed={Math.abs(lev - x) < 0.001} onClick={() => setLev(x)}>{x}×</button>
            ))}
          </div>
        </div>

        <div className="rows">
          <div className="row"><span>Trove collateral</span><span>{fmtBtc(fromWad(plan.totalColl), 4)} BTC</span></div>
          <div className="row"><span>Flash-borrowed</span><span>{fmtBtc(fromWad(plan.flashBtc), 4)} BTC</span></div>
          <div className="row"><span>Trove debt</span><span>{fmtNum(debtShown)} MUSD</span></div>
          <div className="row"><span>Collateral ratio</span><span>{fmtPct(plan.icr, 1)}</span></div>
          <div className="row row--strong"><span>Liquidation price</span><span>{fmtUsd(plan.liqPrice)} <span className="faint">({fmtPct(plan.liqPrice / price - 1, 0)})</span></span></div>
          <div className="row"><span>Interest a year</span><span>{fmtNum(plan.interestYear)} MUSD</span></div>
          <div className="row"><span>Pool price · impact</span><span>{fmtUsd(plan.poolPrice || 0)} · {fmtPct(plan.priceImpact, 2)}</span></div>
          <div className="row"><span>Pool vs MUSD oracle</span><span>{gap >= 0 ? '+' : ''}{fmtPct(gap, 1)}{wide && <span className="faint"> · this trade accepts {fmtPct(Math.min(tradeGap + 0.0075, 0.2), 1)}</span>}</span></div>
          <div className="row"><span>Refunded buffer</span><span>{fmtNum(fromWad(plan.refund), 0)} MUSD</span></div>
        </div>
        {plan.status !== 'empty' && plan.status !== 'no-liquidity' && (
          <CostBreakdown rows={buyBtcCosts(m, plan.flashBtc, { borrowed: plan.debtAmount, deposit: plan.deposit, coilFeeBps: m.coilFeeBps, incentiveBps: m.incentiveBps })} />
        )}

        {plan.status === 'below-min-debt' && <p className="note note--danger">MUSD needs at least 1,800 MUSD of debt. Deposit more BTC or raise the leverage.</p>}
        {plan.status === 'tight' && <p className="note note--danger">This would open under 115% after the swap. Coil keeps a 5% cushion over liquidation.</p>}
        {wide && plan.status === 'ok' && (
          <p className="note">
            The pool prices BTC {fmtPct(gap, 1)} {gap >= 0 ? 'above' : 'below'} MUSD's oracle right now. Coil accepts that gap for this one trade, since you send it
            and your signed amounts cap it. Keeper-fired Guards and Recoils stay on the 3% bound.
          </p>
        )}
        {m.recoveryMode && <p className="note note--danger">MUSD is in recovery mode: new loops are paused until the system ratio is back above 150%.</p>}

        <StepList step={actions.step} active={actions.busy === 'Coil'} labels={['Sign the trove in your name', 'Send one transaction', 'Mezo confirms']} />

        <button className="btn btn--block btn--accent" disabled={!!actions.busy || (isConnected && !canGo)}
          onClick={() => (!isConnected ? openConnectModal?.() : actions.coil(plan))}>
          {actions.busy === 'Coil' ? 'Working…' : cta}
        </button>
        {!COIL_ROUTER && (
          <p className="field__hint">
            Preview mode: quotes, risk and radar are live from Mezo testnet. Deploy the router (contracts/script/Deploy.s.sol) and set VITE_COIL_ROUTER to trade.
          </p>
        )}
      </div>
    </section>
  )
}

/** What a trade costs against MUSD's oracle, line by line, before you sign. */
function CostBreakdown({ rows, title = 'Cost against the oracle' }: { rows: CostRow[]; title?: string }) {
  if (!rows.length) return null
  const total = totalCost(rows)
  const f = (v: number) => (Math.abs(v) < 0.005 ? '0' : `${v < 0 ? '−' : ''}${fmtNum(Math.abs(v))}`)
  return (
    <details className="costs">
      <summary>
        <span>{title}</span>
        <span>{f(total)} MUSD{total < 0 ? ' in your favour' : ''}</span>
      </summary>
      <div className="rows">
        {rows.map((r) => (
          <div className="row" key={r.label} title={r.hint}>
            <span>{r.label}</span><span>{f(r.musd)} MUSD{r.musd < -0.005 ? ' (in your favour)' : ''}</span>
          </div>
        ))}
      </div>
      <span className="field__hint">Measured against MUSD's PriceFeed. Negative lines work for you. Interest is not included.</span>
    </details>
  )
}

type FireKind = 'Guard' | 'Shield' | 'Recoil'

/** Anyone may do the keeper's job: the contract checks the trigger, and the bounty goes to whoever fires. */
function FireButton({ kind, due, fire, ready, busy }: { kind: FireKind; due: boolean; fire: (k: FireKind) => void; ready: boolean; busy: string | null }) {
  if (!due) return null
  return (
    <div className="fire">
      <button className="btn btn--ghost" disabled={!ready || !!busy} onClick={() => fire(kind)}>
        {busy === `Fire ${kind}` ? 'Working…' : 'Fire it yourself · earn the bounty'}
      </button>
      <span className="field__hint">This {kind} is due. The keeper usually fires within a minute, but any wallet may: the contract re-checks the trigger.</span>
    </div>
  )
}

function StepList({ step, active, labels }: { step: Step; active: boolean; labels: [string, string, string] }) {
  if (!active && step !== 'done') return null
  const order: Step[] = ['sign', 'send', 'confirm']
  const idx = order.indexOf(step)
  return (
    <div className="steps" aria-live="polite">
      {labels.map((l, i) => (
        <div key={l} className="step" data-s={step === 'done' || i < idx ? 'done' : i === idx ? 'active' : 'idle'}>
          <i>{step === 'done' || i < idx ? '✓' : i + 1}</i>{l}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ manage */

function ManagePanel({ m, trove, actions }: {
  m: MarketState
  trove: { coll: bigint; debt: bigint }
  actions: ReturnType<typeof useCoilActions>
}) {
  const close = planClose(m, { ...trove, status: 1, interestBps: m.interestBps })
  const price = fromWad(m.price)
  const [cut, setCut] = useState(25)
  const floor = 2000n * WAD
  const repay = (() => {
    const want = (trove.debt * BigInt(cut)) / 100n
    return trove.debt - want < floor ? (trove.debt > floor ? trove.debt - floor : 0n) : want
  })()
  let withdraw = 0n
  try { withdraw = repay > 0n ? (amountIn(repay, m.reserveBtc, m.reserveMusd, m.feeBps) * 102n) / 100n : 0n } catch { /* too big */ }
  const collAfter = trove.coll - withdraw
  const debtAfter = trove.debt - repay
  const crAfter = (fromWad(collAfter) * price) / fromWad(debtAfter)

  return (
    <section className="panel panel--sticky" aria-labelledby="manage-h">
      <div className="panel__h">
        <h2 id="manage-h">Your position</h2>
        <span className="pill" data-s="ok">Live trove</span>
      </div>
      <div className="panel__b">
        <div className="field">
          <span className="mono muted">Reduce leverage</span>
          <div className="inp-row">
            {[10, 25, 50].map((c) => (
              <button key={c} className="mini" aria-pressed={c === cut} onClick={() => setCut(c)}>Repay {c}%</button>
            ))}
          </div>
          <div className="rows">
            <div className="row"><span>MUSD repaid (flash)</span><span>{fmtNum(fromWad(repay))}</span></div>
            <div className="row"><span>BTC sold to the pool</span><span>{fmtBtc(fromWad(withdraw), 4)}</span></div>
            <div className="row row--strong"><span>Ratio after</span><span>{fmtPct(crAfter, 0)}</span></div>
          </div>
          <CostBreakdown rows={sellBtcCosts(m, repay)} />
          <StepList step={actions.step} active={actions.busy === 'Deleverage'} labels={['Sign the adjustment', 'Send one transaction', 'Mezo confirms']} />
          <button className="btn btn--block" disabled={!!actions.busy || repay === 0n || !actions.ready}
            onClick={() => actions.deleverage(withdraw, repay, collAfter, debtAfter)}>
            {actions.busy === 'Deleverage' ? 'Working…' : 'Deleverage in one transaction'}
          </button>
        </div>
        <LeverUp m={m} trove={trove} actions={actions} />
        <div className="field" style={{ borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
          <span className="mono muted">Close everything</span>
          <div className="rows">
            <div className="row"><span>Debt repaid (flash)</span><span>{fmtNum(fromWad(close.musdOwed))} MUSD</span></div>
            <div className="row"><span>BTC sold to the pool</span><span>{fmtBtc(fromWad(close.btcToPool), 4)}</span></div>
            <div className="row row--strong"><span>BTC back to you</span><span>{fmtBtc(fromWad(close.btcOut), 5)}</span></div>
          </div>
          <CostBreakdown rows={sellBtcCosts(m, close.musdOwed)} />
          <StepList step={actions.step} active={actions.busy === 'Unwind'} labels={['Sign the close', 'Send one transaction', 'Mezo confirms']} />
          <button className="btn btn--block btn--danger" disabled={!!actions.busy || !close.ok || !actions.ready}
            onClick={() => actions.unwind((close.btcOut * 98n) / 100n)}>
            {actions.busy === 'Unwind' ? 'Working…' : 'Unwind in one transaction'}
          </button>
          {m.recoveryMode && <p className="note note--danger">Closing is paused while MUSD is in recovery mode.</p>}
        </div>
      </div>
    </section>
  )
}

/** Lever an open trove up in one transaction: flash BTC in, borrow the MUSD that pays for it. */
function LeverUp({ m, trove, actions }: {
  m: MarketState
  trove: { coll: bigint; debt: bigint }
  actions: ReturnType<typeof useCoilActions>
}) {
  const price = fromWad(m.price)
  const C = fromWad(trove.coll)
  const D = fromWad(trove.debt)
  const levNow = (C * price) / (C * price - D)
  const [step, setStep] = useState(0.5)
  const plan = releverPlan(m, trove, levNow + step)
  return (
    <div className="field" style={{ borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
      <span className="mono muted">Leverage up · now {levNow.toFixed(2)}×</span>
      <div className="inp-row">
        {[0.25, 0.5, 1].map((v) => (
          <button key={v} className="mini" aria-pressed={v === step} onClick={() => setStep(v)}>+{v}×</button>
        ))}
      </div>
      {plan.ok ? (
        <div className="rows">
          <div className="row"><span>BTC added (flash)</span><span>{fmtBtc(fromWad(plan.addColl), 4)}</span></div>
          <div className="row"><span>MUSD borrowed</span><span>{fmtNum(fromWad(plan.debtIncrease))}</span></div>
          <div className="row row--strong"><span>Ratio after</span><span>{fmtPct(plan.crAfter, 0)}</span></div>
        </div>
      ) : (
        <p className="note">{plan.reason}</p>
      )}
      {plan.ok && <CostBreakdown rows={buyBtcCosts(m, plan.addColl, { borrowed: plan.debtIncrease })} />}
      <span className="field__hint">If MUSD's borrowing capacity is too small, you sign a refinance too; both run in the same transaction.</span>
      <StepList step={actions.step} active={actions.busy === 'Leverage up'} labels={['Sign the adjustment', 'Send one transaction', 'Mezo confirms']} />
      <button className="btn btn--block" disabled={!!actions.busy || !plan.ok || !actions.ready || m.recoveryMode}
        onClick={() => actions.relever(plan.addColl, plan.debtIncrease)}>
        {actions.busy === 'Leverage up' ? 'Working…' : 'Leverage up in one transaction'}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ recoil */

function RecoilPanel({ m, position, live, recoil, actions, fire, fireReady }: {
  m: MarketState
  position: Position
  live: boolean
  recoil?: import('../lib/live').RecoilState
  actions: ReturnType<typeof useCoilActions>
  fire: (k: FireKind) => void
  fireReady: boolean
}) {
  const price = fromWad(m.price)
  const t = { coll: toWad(position.coll), debt: toWad(position.debt) }
  const crNow = (position.coll * price) / position.debt
  const levNow = (position.coll * price) / (position.coll * price - position.debt)
  const [band, setBand] = useState(0.25)
  // fire when the ratio is `band` above today's: BTC rose, or a redemption cut the debt
  const triggerIcr = crNow + band
  // at the trigger the position has lost leverage; the signed relever puts it back to today's
  const plan = releverPlan({ ...m, price: toWad(price * (triggerIcr / crNow)) }, t, levNow, 1.25)
  const demo = releverPlan(m, t, levNow + 0.25, 1.05)
  const armed = recoil?.armed
  // a keeper buys BTC for you only within the 3% bound; past it, Recoil waits
  const gap = poolGap(m.reserveMusd, m.reserveBtc, m.price)
  const held = gap * 10_000 > DEFAULT_DEVIATION_BPS
  // "do it now": the same BTC the Recoil adds, sent by you at today's quote (your own tolerance)
  const nowAdd = armed && recoil!.fresh ? recoil!.addColl : 0n
  let nowDebt = 0n
  try { nowDebt = nowAdd > 0n ? (amountIn(nowAdd, m.reserveMusd, m.reserveBtc, m.feeBps) * 1005n) / 1000n : 0n } catch { /* pool too thin */ }
  const nowCr = nowDebt > 0n ? ((position.coll + fromWad(nowAdd)) * price) / (position.debt + fromWad(nowDebt) * 1.001) : 0
  const nowCosts = nowDebt > 0n ? buyBtcCosts(m, nowAdd, { borrowed: nowDebt }) : []
  return (
    <section className="panel" aria-labelledby="recoil-h">
      <div className="panel__h">
        <h2 id="recoil-h">Recoil · back to target leverage</h2>
        {armed ? (
          <span className="pill" data-s={recoil!.fresh ? (recoil!.triggered ? 'danger' : 'ok') : 'watch'}>
            {recoil!.fresh ? (recoil!.triggered ? (held ? 'Triggered, held by the 3% bound' : 'Triggered, waiting for a keeper') : `Armed at ${fmtPct(recoil!.triggerIcr, 0)}`) : 'Stale, sign again'}
          </span>
        ) : (
          <span className="pill" data-s="idle">Not armed</span>
        )}
      </div>
      <div className="panel__b">
        <div className="field">
          <span className="mono muted">Fire when the ratio climbs by</span>
          <div className="inp-row">
            {[0.15, 0.25, 0.5].map((v) => <button key={v} className="mini" aria-pressed={v === band} onClick={() => setBand(v)}>+{Math.round(v * 100)} pts</button>)}
          </div>
        </div>
        {plan.ok ? (
          <div className="rows">
            <div className="row"><span>Fires at a ratio of</span><span>{fmtPct(triggerIcr, 0)}</span></div>
            <div className="row"><span>Adds, at most</span><span>{fmtBtc(fromWad(plan.addColl), 4)} BTC · {fmtNum(fromWad(plan.debtIncrease))} MUSD</span></div>
            <div className="row"><span>Leverage restored to</span><span>{levNow.toFixed(2)}×</span></div>
            <div className="row"><span>Keeper bounty</span><span>0.30% of the MUSD borrowed</span></div>
            {recoil && <div className="row"><span>Borrowing capacity left</span><span>{fmtNum(fromWad(recoil.capacity))} MUSD</span></div>}
          </div>
        ) : (
          <p className="note">{plan.reason}</p>
        )}
        {held && (
          <div className="note choice">
            <p style={{ margin: 0 }}>
              <b>The pool prices BTC {fmtPct(gap, 1)} above MUSD's oracle.</b> A keeper may only buy BTC for you within 3% of the oracle, so a Recoil can't fire
              right now: nobody can lever you up that dear while you're away. Two choices:
            </p>
            <div className="choice__opts">
              <div>
                <b>Wait</b>
                <span>{armed ? 'Your Recoil stays armed' : 'Arm it as usual'} and fires once the pool is back within 3%. Nothing to do.</span>
              </div>
              <div>
                <b>Do it now, yourself</b>
                {nowDebt > 0n && nowCr >= 1.15 ? (
                  <>
                    <span>
                      Add {fmtBtc(fromWad(nowAdd), 4)} BTC at today's pool price: it costs about {fmtNum(totalCost(nowCosts))} MUSD more than at the oracle
                      ({fmtPct(gap, 1)} gap, pool fee, impact, MUSD's 0.10% borrowing fee). Ratio after: {fmtPct(nowCr, 0)}. It replaces the armed Recoil.
                    </span>
                    <CostBreakdown rows={nowCosts} title="Cost of levering up now" />
                    <button className="btn" disabled={!live || !!actions.busy || !actions.ready} onClick={() => actions.relever(nowAdd, nowDebt)}>
                      {actions.busy === 'Leverage up' ? 'Working…' : `Lever up now, accept the ${fmtPct(gap, 1)} gap`}
                    </button>
                  </>
                ) : (
                  <span>Use Leverage up in your position panel: you send it, you accept the gap, and the cost shows before you sign.</span>
                )}
              </div>
            </div>
          </div>
        )}
        <p className="field__hint" style={{ margin: 0 }}>
          When BTC rises, or a redemption shrinks your debt, your position loses leverage. Recoil is a signed leverage-up that the keeper runs once your ratio reaches the trigger, with the same price-feed bound as every Coil swap. Redemptions stop being a reason to watch the screen.
        </p>
        <StepList step={actions.step} active={actions.busy === 'Arm Recoil'} labels={['Sign the leverage-up', 'Store it with the trigger', 'Mezo confirms']} />
        <div className="cta-row">
          <button className="btn" disabled={!live || !plan.ok || !!actions.busy || !actions.ready}
            onClick={() => actions.armRecoil(triggerIcr, plan.addColl, plan.debtIncrease, 30)}>
            {actions.busy === 'Arm Recoil' ? 'Working…' : armed ? 'Re-arm Recoil' : 'Arm Recoil'}
          </button>
          {armed && <button className="btn btn--ghost" disabled={!!actions.busy} onClick={() => actions.disarmRecoil()}>Disarm</button>}
          {live && demo.ok && (
            <button className="btn btn--ghost" disabled={!!actions.busy || !actions.ready}
              onClick={() => actions.armRecoil(Math.max(1.12, crNow - 0.02), demo.addColl, demo.debtIncrease, 1)}
              title="Arms a Recoil your trove already qualifies for: the keeper levers it up by 0.25x within a minute">
              Test it now
            </button>
          )}
        </div>
        <FireButton kind="Recoil" due={!!armed && !!recoil?.fresh && !!recoil?.triggered && !held} fire={fire} ready={fireReady} busy={actions.busy} />
        {!live && <p className="field__hint" style={{ margin: 0 }}>Open the position first; Recoil manages a live trove.</p>}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ position */

function PositionPanel({ position, cr, liq, price, trove, interestBps, guardCr }: {
  position: Position | null
  cr: number
  liq: number
  price: number
  trove: boolean
  interestBps: number
  guardCr?: number
}) {
  const { address } = useAccount()
  const crShown = useTweened(Number.isFinite(cr) ? cr : 0)
  const liqShown = useTweened(liq)
  const state = cr < 1.1 ? 'danger' : cr < 1.3 ? 'danger' : cr < 1.6 ? 'watch' : 'ok'
  const label = { ok: 'Comfortable', watch: 'Watch', danger: 'Tight' }[state]
  if (!position) {
    return (
      <section className="panel">
        <div className="panel__h"><h2>Position</h2><span className="pill" data-s="idle">Nothing yet</span></div>
        <div className="empty">
          <span>Enter a deposit on the left. The cockpit fills with a preview of that position, using live Mezo data.</span>
        </div>
      </section>
    )
  }
  const equityBtc = position.coll - position.debt / price
  return (
    <section className="panel" aria-labelledby="pos-h">
      <div className="panel__h">
        <h2 id="pos-h">{trove ? 'Your trove' : 'Preview of this plan'}</h2>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {trove && address && <a className="mono muted" href={explorerAddr(address)} target="_blank" rel="noreferrer">{shortAddr(address)}</a>}
          <span className="pill" data-s={trove ? state : 'accent'}>{trove ? label : 'Preview'}</span>
        </span>
      </div>
      <div className="kpis">
        <div className="kpi kpi--accent"><span className="mono">Collateral</span><span className="kpi__v">{fmtBtc(position.coll, 4)} BTC</span><span className="kpi__s">{fmtUsd(position.coll * price)}</span></div>
        <div className="kpi"><span className="mono">Debt</span><span className="kpi__v">{fmtNum(position.debt)}</span><span className="kpi__s">MUSD at {(interestBps / 100).toFixed(2)}% fixed</span></div>
        <div className="kpi"><span className="mono">Ratio</span><span className="kpi__v">{fmtPct(crShown, 1)}</span><span className="kpi__s">liquidation under 110%</span></div>
        <div className="kpi"><span className="mono">Liquidation price</span><span className="kpi__v">{fmtUsd(liqShown)}</span><span className="kpi__s">{fmtPct(liq / price - 1, 1)} from today</span></div>
      </div>
      <div className="panel__b">
        <Gauge cr={cr} guardCr={guardCr} />
        <p className="field__hint" style={{ margin: 0 }}>
          Net value {fmtBtc(equityBtc, 4)} BTC ({fmtUsd(equityBtc * price)}). Every 10% BTC move changes it by about {fmtPct((position.coll * price * 0.1) / (equityBtc * price), 0)}.
          {guardCr ? ' The orange mark is where your Guard fires.' : ''}
        </p>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ risk */

function RiskPanel({ price, liq, vol, histVol, setVol, volOverride, closes, stepDays, source, trigger }: {
  price: number
  liq: number
  vol: number
  histVol: number
  setVol: (v: number | null) => void
  volOverride: number | null
  closes?: number[]
  stepDays: number
  source?: string
  trigger: number
}) {
  const [days, setDays] = useState(30)
  const horizons = [7, 30, 90]
  const dd = 1 - liq / price
  return (
    <section className="panel" aria-labelledby="risk-h">
      <div className="panel__h">
        <h2 id="risk-h">Liquidation odds</h2>
        <div className="tabs" role="group" aria-label="Horizon">
          {horizons.map((d) => <button key={d} aria-pressed={d === days} onClick={() => setDays(d)}>{d} days</button>)}
        </div>
      </div>
      <div className="panel__b">
        <div className="probs">
          {horizons.map((d) => {
            const p = touchProbability(price, liq, vol, d / 365)
            const h = closes ? historicalTouchRate(closes, dd, Math.max(1, Math.round(d / stepDays))) : NaN
            return (
              <div className="prob" key={d}>
                <span className="mono muted">{d} days</span>
                <span className="prob__v">{fmtPct(p, 1)}</span>
                <span className="prob__bar"><i style={{ transform: `scaleX(${Math.min(1, p)})` }} /></span>
                <span className="prob__s">Model. History since 2019: {Number.isFinite(h) ? fmtPct(h, 1) : '…'} of {d}-day windows.</span>
              </div>
            )
          })}
        </div>
        <div className="field">
          <div className="field__top">
            <label className="mono" htmlFor="vol">Volatility</label>
            <span className="field__val">{fmtPct(vol, 0)} a year {volOverride === null ? `· realized ${stepDays === 1 ? '30d' : '8w'}` : ''}</span>
          </div>
          <input id="vol" type="range" min={0.2} max={1.2} step={0.01} value={vol} style={{ ['--p' as string]: `${((vol - 0.2) / 1) * 100}%` }}
            onChange={(e) => setVol(Number(e.target.value))} />
          <span className="field__hint">
            Drift-free GBM first-passage to {fmtUsd(liq)}. Realized volatility is {fmtPct(histVol, 0)} from {source === 'binance' ? 'Binance daily closes' : 'the bundled weekly snapshot'}.
            {volOverride !== null && <> <button className="mini" onClick={() => setVol(null)}>Use realized</button></>}
          </span>
        </div>
      </div>
      <div className="board" style={{ margin: '0 20px 20px' }}>
        <div className="board__bar">
          <span className="board__title mono"><i />Monte Carlo · 220 paths · {days} days</span>
          <span className="mono">σ {fmtPct(vol, 0)}</span>
        </div>
        <Fan s0={price} sigma={vol} days={days} liq={liq} trigger={trigger} />
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ radar */

function RadarPanel({ radar, loading, cr, self }: {
  radar?: import('../lib/live').Radar
  loading: boolean
  cr: number
  self?: `0x${string}`
}) {
  const shield = radar ? redemptionShield(radar, cr, self) : null
  const shieldShown = useTweened(shield?.musdAhead ?? 0, 0.9)
  return (
    <section className="panel" aria-labelledby="radar-h">
      <div className="panel__h">
        <h2 id="radar-h">Redemption radar</h2>
        <span className="mono muted">{radar ? `${radar.troves.length} troves read live` : loading ? 'Reading every trove…' : 'Unavailable'}</span>
      </div>
      <div className="panel__b">
        {shield ? (
          <>
            <div className="kpis" style={{ border: '1px solid var(--rule)', borderRadius: 4 }}>
              <div className="kpi kpi--accent"><span className="mono">MUSD ahead of you</span><span className="kpi__v">{fmtCompact(shieldShown)}</span><span className="kpi__s">must be redeemed before your trove</span></div>
              <div className="kpi"><span className="mono">Queue position</span><span className="kpi__v">{shield.rank} / {shield.of}</span><span className="kpi__s">1 is redeemed first</span></div>
              <div className="kpi"><span className="mono">Your ratio</span><span className="kpi__v">{fmtPct(cr, 0)}</span><span className="kpi__s">redemptions take the lowest first</span></div>
              <div className="kpi"><span className="mono">Redemption fee</span><span className="kpi__v">0.75%</span><span className="kpi__s">paid by the redeemer</span></div>
            </div>
            <RadarStrip radar={radar!} cr={cr} self={self} />
            <p className="field__hint" style={{ margin: 0 }}>
              A redemption swaps your debt for BTC at the oracle price: you lose BTC upside but not value. More leverage moves you left, toward the front of the queue.
            </p>
          </>
        ) : loading ? (
          <div className="skeleton" style={{ height: 160 }} />
        ) : (
          <p className="note">Could not read the troves from the Mezo RPC. The radar retries every 90 seconds.</p>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ guard */

function GuardPanel({ m, position, trigger, setTrigger, lo, hi, live, guard, actions, fire, fireReady }: {
  m: MarketState
  position: Position
  trigger: number
  setTrigger: (v: number) => void
  lo: number
  hi: number
  live: boolean
  guard?: import('../lib/live').GuardState
  actions: ReturnType<typeof useCoilActions>
  fire: (k: FireKind) => void
  fireReady: boolean
}) {
  // Guard sells BTC: a keeper may only do it within 3% of the oracle. Past that (pool BTC cheap), it waits.
  const gapNow = poolGap(m.reserveMusd, m.reserveBtc, m.price)
  const held = -gapNow * 10_000 > DEFAULT_DEVIATION_BPS
  const nowRepay = guard?.armed && guard.fresh ? guard.debtRepay : 0n
  let nowWithdraw = 0n
  try { nowWithdraw = nowRepay > 0n ? (amountIn(nowRepay, m.reserveBtc, m.reserveMusd, m.feeBps) * 102n) / 100n : 0n } catch { /* too big */ }
  const nowCosts = nowRepay > 0n ? sellBtcCosts(m, nowRepay) : []
  const [target, setTarget] = useState(1.6)
  const [days, setDays] = useState(30)
  const price = fromWad(m.price)
  const t = { coll: BigInt(Math.round(position.coll * 1e6)) * 10n ** 12n, debt: BigInt(Math.round(position.debt * 1e6)) * 10n ** 12n, status: 1, interestBps: m.interestBps }
  const g = planGuard(m, t, trigger, target, fromWad(m.minNetDebt))
  // "Test it now": a Guard at today's price fires on the keeper's next pass (every few minutes).
  const crNow = (position.coll * price) / position.debt
  const demo = planGuard(m, t, Math.floor(price * 1.002), Math.max(crNow + 0.1, target), fromWad(m.minNetDebt))
  const pct = hi > lo ? ((trigger - lo) / (hi - lo)) * 100 : 0
  const armed = guard?.armed
  return (
    <section className="panel" aria-labelledby="guard-h">
      <div className="panel__h">
        <h2 id="guard-h">Guard · signed stop-loss</h2>
        {armed ? (
          <span className="pill" data-s={guard!.fresh ? (guard!.triggered ? 'danger' : 'ok') : 'watch'}>
            {guard!.fresh ? (guard!.triggered ? (held ? 'Triggered, held by the 3% bound' : 'Triggered, waiting for a keeper') : `Armed at ${fmtUsd(fromWad(guard!.triggerPrice))}`) : 'Stale, sign again'}
          </span>
        ) : (
          <span className="pill" data-s="idle">Not armed</span>
        )}
      </div>
      <div className="panel__b">
        <div className="field">
          <div className="field__top">
            <label className="mono" htmlFor="trigger">Trigger price</label>
            <span className="field__val">{fmtUsd(trigger)} <span className="faint">({fmtPct(trigger / price - 1, 0)})</span></span>
          </div>
          <input id="trigger" type="range" min={lo} max={hi} step={10} value={trigger} style={{ ['--p' as string]: `${pct}%` }}
            onChange={(e) => setTrigger(Number(e.target.value))} />
          <div className="ticks"><span>liq + 3% · {fmtUsd(lo)}</span><span>today · {fmtUsd(price)}</span></div>
        </div>
        <div className="field">
          <span className="mono muted">Ratio to land on</span>
          <div className="inp-row">
            {[1.4, 1.6, 2].map((v) => <button key={v} className="mini" aria-pressed={v === target} onClick={() => setTarget(v)}>{Math.round(v * 100)}%</button>)}
            <span style={{ flex: 1 }} />
            {[7, 30, 90].map((d) => <button key={d} className="mini" aria-pressed={d === days} onClick={() => setDays(d)}>{d}d</button>)}
          </div>
        </div>
        {g.ok ? (
          <div className="rows">
            <div className="row"><span>Ratio when it fires</span><span>{fmtPct(g.crAtTrigger, 0)}</span></div>
            <div className="row"><span>MUSD repaid (flash)</span><span>{fmtNum(fromWad(g.repay))}</span></div>
            <div className="row"><span>BTC sold, at most</span><span>{fmtBtc(fromWad(g.withdraw), 4)}</span></div>
            <div className="row row--strong"><span>Ratio after</span><span>{fmtPct(g.crAfter, 0)}</span></div>
            <div className="row"><span>BTC back to you, at least</span><span>{fmtBtc(fromWad(g.minBtcOut), 5)}</span></div>
            <div className="row"><span>Keeper bounty</span><span>0.30% of the BTC released</span></div>
          </div>
        ) : (
          <p className="note">{g.reason}</p>
        )}
        <p className="field__hint" style={{ margin: 0 }}>
          You sign one exact adjustment now. Coil stores it on-chain with the trigger; once MUSD's price feed is at or below it, any keeper can run it. The swap is bounded by MUSD's own price feed, so nobody can move the pool and sell your BTC cheap. Works on any MUSD trove, opened with Coil or in the Mezo app. Another signed change to your trove makes the signature stale, so you re-arm after.
        </p>
        <StepList step={actions.step} active={actions.busy === 'Arm Guard'} labels={['Sign the deleverage', 'Store it with the trigger', 'Mezo confirms']} />
        <div className="cta-row">
          <button className="btn" disabled={!live || !g.ok || !!actions.busy || !actions.ready} onClick={() => actions.armGuard(g, 30, days)}>
            {actions.busy === 'Arm Guard' ? 'Working…' : armed ? 'Re-arm Guard' : 'Arm Guard'}
          </button>
          {armed && <button className="btn btn--ghost" disabled={!!actions.busy} onClick={() => actions.disarmGuard()}>Disarm</button>}
          {live && demo.ok && (
            <button className="btn btn--ghost" disabled={!!actions.busy || !actions.ready} onClick={() => actions.armGuard(demo, 30, 1)}
              title="Arms a Guard at today's price: the keeper fires it within minutes, so you can watch it on the explorer">
              Test it now
            </button>
          )}
        </div>
        <FireButton kind="Guard" due={!!armed && !!guard?.fresh && !!guard?.triggered && !held && !guard?.recoveryMode} fire={fire} ready={fireReady} busy={actions.busy} />
        {held && (
          <div className="note choice">
            <p style={{ margin: 0 }}>
              <b>The pool prices BTC {fmtPct(-gapNow, 1)} under MUSD's oracle.</b> A keeper may only sell your BTC within 3% of the oracle, so a Guard can't fire
              right now: nobody can sell it that cheap while you're away. Two choices:
            </p>
            <div className="choice__opts">
              <div><b>Wait</b><span>{armed ? 'Your Guard stays armed' : 'Arm it as usual'} and fires once the pool is back within 3% (if the trigger still holds).</span></div>
              <div>
                <b>Reduce leverage now, yourself</b>
                {nowRepay > 0n && nowWithdraw > 0n ? (
                  <>
                    <span>Repay {fmtNum(fromWad(nowRepay))} MUSD by selling about {fmtBtc(fromWad(nowWithdraw), 4)} BTC: it costs about {fmtNum(totalCost(nowCosts))} MUSD more than at the oracle. It replaces the armed Guard.</span>
                    <CostBreakdown rows={nowCosts} title="Cost of reducing now" />
                    <button className="btn" disabled={!live || !!actions.busy || !actions.ready}
                      onClick={() => actions.deleverage(nowWithdraw, nowRepay, toWad(position.coll) - nowWithdraw, toWad(position.debt) - nowRepay)}>
                      {actions.busy === 'Deleverage' ? 'Working…' : `Deleverage now, accept the ${fmtPct(-gapNow, 1)} gap`}
                    </button>
                  </>
                ) : (
                  <span>Use Reduce leverage in your position panel: you send it, you accept the gap, and the cost shows before you sign.</span>
                )}
              </div>
            </div>
          </div>
        )}
        {(guard?.recoveryMode || m.recoveryMode) && (
          <p className="note note--danger">MUSD is in Recovery Mode: collateral can't leave a trove, so a Guard can't fire. A Shield, which only repays debt from your Reserve, still can.</p>
        )}
        {!live && <p className="field__hint" style={{ margin: 0 }}>Open the position first; a Guard protects a live trove.</p>}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ reserve and shield */

function ShieldPanel({ m, position, live, trigger, reserve, shield, actions, fire, fireReady }: {
  m: MarketState
  position: Position
  live: boolean
  trigger: number
  reserve?: import('../lib/live').ReserveState
  shield?: import('../lib/live').ShieldState
  actions: ReturnType<typeof useCoilActions>
  fire: (k: FireKind) => void
  fireReady: boolean
}) {
  const [amountStr, setAmountStr] = useState('')
  const [share, setShare] = useState(0.25)
  const [buffer, setBuffer] = useState(50_000)
  const [usePrice, setUsePrice] = useState(true)
  const [days, setDays] = useState(30)
  const t = { coll: toWad(position.coll), debt: toWad(position.debt), status: 1, interestBps: m.interestBps }
  const sp = planShield(t, share, trigger, fromWad(m.minNetDebt))
  const reserveMusd = reserve ? fromWad(reserve.reserve) : 0
  const walletMusd = reserve ? fromWad(reserve.wallet) : 0
  const amount = Number((amountStr || '0').replace(',', '.'))
  const needed = fromWad(sp.repay) + 5
  const ahead = shield ? fromWad(shield.ahead) : null
  const armed = shield?.armed
  return (
    <section className="panel" aria-labelledby="shield-h">
      <div className="panel__h">
        <h2 id="shield-h">Reserve and Shield · redemption protection</h2>
        {armed ? (
          <span className="pill" data-s={shield!.fresh ? (shield!.funded ? (shield!.byPrice || shield!.byQueue ? 'danger' : 'ok') : 'watch') : 'watch'}>
            {!shield!.fresh ? 'Stale, sign again' : !shield!.funded ? 'Armed, Reserve too low' : shield!.byPrice || shield!.byQueue ? 'Triggered, waiting for a keeper' : 'Armed'}
          </span>
        ) : (
          <span className="pill" data-s="idle">Not armed</span>
        )}
      </div>
      <div className="kpis">
        <div className="kpi kpi--accent"><span className="mono">Reserve</span><span className="kpi__v">{fmtNum(reserveMusd)}</span><span className="kpi__s">MUSD in Mezo's sMUSD, earning its yield</span></div>
        <div className="kpi"><span className="mono">Redeemable ahead</span><span className="kpi__v">{ahead === null ? '…' : `${fmtCompact(ahead)}${shield?.found ? '' : '+'}`}</span><span className="kpi__s">MUSD redeemed before your trove</span></div>
        <div className="kpi"><span className="mono">Wallet</span><span className="kpi__v">{fmtNum(walletMusd)}</span><span className="kpi__s">MUSD you can add</span></div>
      </div>
      <div className="panel__b">
        <div className="field">
          <span className="mono muted">Fund the Reserve</span>
          <div className="inp-row">
            <input className="inp" inputMode="decimal" placeholder="MUSD" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} aria-label="MUSD amount" />
            <button className="mini" onClick={() => setAmountStr(String(Math.floor(walletMusd)))} disabled={!walletMusd}>Max</button>
            <button className="btn" disabled={!live && !reserve || !(amount > 0) || amount > walletMusd + 1e-9 || !!actions.busy || !actions.ready}
              onClick={() => actions.depositReserve(toWad(amount))}>
              {actions.busy === 'Fund Reserve' ? 'Working…' : 'Add'}
            </button>
            <button className="btn btn--ghost" disabled={!reserveMusd || !!actions.busy || !actions.ready}
              onClick={() => actions.withdrawReserve((1n << 256n) - 1n)}>
              {actions.busy === 'Withdraw Reserve' ? 'Working…' : 'Withdraw all'}
            </button>
          </div>
          {!!reserve && reserve.legacy > 0n && (
            <div className="note">
              {fmtNum(fromWad(reserve.legacy))} MUSD is still in your Reserve on the previous Coil version.{' '}
              <button className="mini" disabled={!!actions.busy || !actions.ready} onClick={() => actions.withdrawLegacyReserve()}>
                {actions.busy === 'Withdraw v2 Reserve' ? 'Working…' : 'Move it to your wallet'}
              </button>
            </div>
          )}
          <span className="field__hint">Only you can withdraw it. The only other thing that can move it is your own signed Shield, and only to repay your own trove.</span>
        </div>
        <div className="field">
          <span className="mono muted">Shield repays</span>
          <div className="inp-row">
            {[0.1, 0.25, 0.5].map((v) => <button key={v} className="mini" aria-pressed={v === share} onClick={() => setShare(v)}>{Math.round(v * 100)}% of debt</button>)}
          </div>
        </div>
        <div className="field">
          <span className="mono muted">Fires when</span>
          <div className="inp-row">
            <button className="mini" aria-pressed={usePrice} onClick={() => setUsePrice(!usePrice)}>BTC ≤ {fmtUsd(trigger)}</button>
            <span className="faint">or less than</span>
            {[10_000, 50_000, 250_000].map((v) => <button key={v} className="mini" aria-pressed={v === buffer} onClick={() => setBuffer(v)}>{fmtCompact(v)} MUSD</button>)}
            <span className="faint">stands ahead in the redemption queue</span>
          </div>
          <div className="inp-row">
            {[7, 30, 90].map((d) => <button key={d} className="mini" aria-pressed={d === days} onClick={() => setDays(d)}>{d}d</button>)}
          </div>
        </div>
        {sp.ok ? (
          <div className="rows">
            <div className="row"><span>MUSD repaid from the Reserve</span><span>{fmtNum(fromWad(sp.repay))}</span></div>
            <div className="row"><span>Ratio after, at the trigger</span><span>{fmtPct(sp.crAfterAtTrigger, 0)}</span></div>
            <div className="row"><span>Keeper bounty</span><span>5 MUSD from the Reserve</span></div>
            <div className={`row ${reserveMusd >= needed ? '' : 'row--strong'}`}><span>Reserve needed</span><span>{fmtNum(needed)} MUSD{reserveMusd >= needed ? ' ✓' : ''}</span></div>
          </div>
        ) : (
          <p className="note">{sp.reason}</p>
        )}
        <p className="field__hint" style={{ margin: 0 }}>
          On Mezo the common way to lose a position is a redemption, not a liquidation: redeemers swap MUSD for the BTC of the lowest-ratio troves first, and leveraged troves sit near the front. The Shield watches that queue on-chain. When too little debt stands before you, a keeper repays part of your debt from the Reserve, which moves you back. It only repays, so it also works in Recovery Mode, when collateral can't leave a trove.
        </p>
        {live && sp.ok && reserveMusd < needed && (
          <p className="note note--danger" style={{ margin: 0 }}>
            Your Reserve holds {fmtNum(reserveMusd)} MUSD and this Shield needs {fmtNum(needed)}. You can arm it now, but it can only fire once
            you add {fmtNum(needed - reserveMusd)} MUSD (or pick a smaller repayment).
          </p>
        )}
        <StepList step={actions.step} active={actions.busy === 'Arm Shield'} labels={['Sign the repayment', 'Store it with the triggers', 'Mezo confirms']} />
        <div className="cta-row">
          <button className="btn" disabled={!live || !sp.ok || !!actions.busy || !actions.ready}
            onClick={() => actions.armShield(sp.repay, usePrice ? trigger : 0, buffer, days)}>
            {actions.busy === 'Arm Shield' ? 'Working…' : armed ? 'Re-arm Shield' : 'Arm Shield'}
          </button>
          {armed && <button className="btn btn--ghost" disabled={!!actions.busy} onClick={() => actions.disarmShield()}>Disarm</button>}
          {live && sp.ok && (
            <button className="btn btn--ghost" disabled={!!actions.busy || !actions.ready || reserveMusd < needed}
              onClick={() => actions.armShield(sp.repay, Math.ceil(fromWad(m.price) * 1.002), 0, 1)}
              title={reserveMusd < needed ? 'Fund the Reserve first' : "Arms a Shield at today's price: the keeper repays from your Reserve within a minute"}>
              Test it now
            </button>
          )}
        </div>
        <FireButton kind="Shield" due={!!armed && !!shield?.fresh && !!shield?.funded && (!!shield?.byPrice || !!shield?.byQueue)} fire={fire} ready={fireReady} busy={actions.busy} />
        {!live && <p className="field__hint" style={{ margin: 0 }}>Open the position first; a Shield protects a live trove.</p>}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ replay */

const day = (y: number, mo: number, d: number) => Math.round(Date.UTC(y, mo - 1, d) / 86_400_000)

function ReplayPanel({ closes, startDay, stepDays, leverage, interestBps, source }: {
  closes: number[]
  startDay: number
  stepDays: number
  leverage: number
  interestBps: number
  source: string
}) {
  const today = startDay + (closes.length - 1) * stepDays
  const windows: ReplayWindow[] = [
    { label: 'Last 90 days', from: today - 90 },
    { label: 'Last 12 months', from: today - 365 },
    { label: 'March 2020', from: day(2020, 2, 10), to: day(2020, 6, 30) },
    { label: '2021 top', from: day(2021, 11, 1), to: day(2022, 12, 31) },
    { label: 'Since 2019', from: startDay },
  ]
  const [i, setI] = useState(1)
  const lev = Number.isFinite(leverage) && leverage > 1 ? leverage : 2
  return (
    <section className="panel" aria-labelledby="replay-h">
      <div className="panel__h">
        <h2 id="replay-h">Replay through history</h2>
        <div className="tabs" role="group" aria-label="Period">
          {windows.map((w, k) => <button key={w.label} aria-pressed={k === i} onClick={() => setI(k)}>{w.label}</button>)}
        </div>
      </div>
      <div className="panel__b">
        <ReplayChart closes={closes} startDay={startDay} stepDays={stepDays} leverage={lev} interestBps={interestBps} win={windows[i]} />
        <p className="field__hint" style={{ margin: 0 }}>
          {lev.toFixed(2)}× opened at the start of the period, never adjusted, measured in BTC. {source === 'binance' ? 'Binance BTCUSDT daily closes.' : 'Bundled weekly snapshot (live history unavailable).'} Interest at {(interestBps / 100).toFixed(2)}%; no Guard.
        </p>
      </div>
    </section>
  )
}


/* ------------------------------------------------------------------ activity */

const KIND_COPY: Record<ActivityItem['kind'], string> = {
  Coiled: 'Coil', Unwound: 'Unwind', Delevered: 'Deleverage', GuardArmed: 'Guard armed', GuardDisarmed: 'Guard disarmed', GuardFired: 'Guard fired',
  ReserveDeposited: 'Reserve in', ReserveWithdrawn: 'Reserve out', ShieldArmed: 'Shield armed', ShieldDisarmed: 'Shield disarmed', ShieldFired: 'Shield fired',
  Relevered: 'Leverage up', RecoilArmed: 'Recoil armed', RecoilDisarmed: 'Recoil disarmed', RecoilFired: 'Recoil fired',
  IncentivesAccrued: 'Gauge incentive', IncentivesPushed: 'Incentives sent',
}

function activityDetail(i: ActivityItem) {
  const a = i.args as Record<string, bigint>
  const btc = (v: bigint) => `${fmtBtc(fromWad(v), 4)} BTC`
  const musd = (v: bigint) => `${fmtNum(fromWad(v))} MUSD`
  switch (i.kind) {
    case 'Coiled': return `${btc(a.deposit)} in, ${btc(a.totalColl)} collateral, ${musd(a.debtAmount)} borrowed`
    case 'Unwound': return `${musd(a.musdRepaid)} repaid, ${btc(a.btcOut)} back`
    case 'Delevered': return `${musd(a.debtRepaid)} repaid, ${btc(a.btcOut)} back`
    case 'GuardArmed': return `trigger ${fmtUsd(fromWad(a.triggerPrice))}, repays ${musd(a.debtRepay)}`
    case 'GuardFired': return `at ${fmtUsd(fromWad(a.price))}, ${btc(a.btcToUser)} to the owner`
    case 'ReserveDeposited': return `${musd(a.amount)} into sMUSD`
    case 'ReserveWithdrawn': return `${musd(a.amount)} back to the wallet`
    case 'ShieldArmed': return `repays ${musd(a.repayAmount)}${a.triggerPrice ? ` at ${fmtUsd(fromWad(a.triggerPrice))}` : ''}${a.maxDebtAhead ? `, or under ${fmtCompact(fromWad(a.maxDebtAhead))} MUSD ahead` : ''}`
    case 'Relevered': return `${btc(a.collAdded)} added, ${musd(a.debtAdded)} borrowed`
    case 'RecoilArmed': return `fires at ${fmtPct(Number(a.triggerIcr) / 1e18, 0)}, adds ${btc(a.addColl)}`
    case 'RecoilFired': return `at ${fmtPct(Number(a.icr) / 1e18, 0)}, back to target leverage`
    case 'IncentivesAccrued': return `${musd(a.amount)} for the MUSD/BTC gauge`
    case 'IncentivesPushed': return `${musd(a.amount)} to the MUSD/BTC gauge incentives`
    case 'ShieldFired': return `${musd(a.repaid)} repaid from the Reserve, ${(i.args.byRedemptionQueue as boolean) ? 'redemption trigger' : `at ${fmtUsd(fromWad(a.price))}`}`
    default: return ''
  }
}

function ago(t?: number) {
  if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

function ActivityPanel({ self }: { self?: `0x${string}` }) {
  const q = useActivity()
  const [mine, setMine] = useState(false)
  const items = (q.data?.items ?? []).filter((i) => !mine || (self && i.user.toLowerCase() === self.toLowerCase()))
  return (
    <section className="panel" id="activity" aria-labelledby="act-h">
      <div className="panel__h">
        <h2 id="act-h">On-chain activity</h2>
        {q.data && <span className="mono muted">{q.data.wallets} wallets · {q.data.total} transactions · {q.data.fires} keeper fires</span>}
        <span className="act__tabs" role="group" aria-label="Filter">
          <button className={!mine ? 'is-on' : ''} onClick={() => setMine(false)}>All</button>
          <button className={mine ? 'is-on' : ''} onClick={() => setMine(true)} disabled={!self} title={self ? undefined : 'Connect a wallet'}>Yours</button>
        </span>
      </div>
      <div className="panel__b">
        {q.isLoading ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : q.isError ? (
          <p className="note">Could not read CoilRouter events from the Mezo RPC. Retrying every 20 seconds.</p>
        ) : items.length === 0 ? (
          <p className="note">{mine ? 'No Coil transactions from this wallet yet.' : 'No Coil transactions yet. Yours will show up here with a link to the explorer.'}</p>
        ) : (
          <ol className="act">
            {items.slice(0, 40).map((i) => (
              <li key={i.tx + i.kind}>
                <span className="act__k" data-k={i.kind}>{KIND_COPY[i.kind]}</span>
                <span className="act__d">{activityDetail(i)}</span>
                <span className="act__m mono muted">
                  {self && i.user.toLowerCase() === self.toLowerCase() ? 'You' : shortAddr(i.user)}{i.time ? ` · ${ago(i.time)}` : ''}{i.router === 'v1' ? ' · v1' : ''}
                </span>
                <a className="act__tx mono" href={explorerTx(i.tx)} target="_blank" rel="noreferrer">{shortAddr(i.tx)} ↗</a>
              </li>
            ))}
          </ol>
        )}
        <p className="act__foot mono muted">
          {COIL_ROUTER && <a href={explorerAddr(COIL_ROUTER)} target="_blank" rel="noreferrer">CoilRouter v2 {shortAddr(COIL_ROUTER)} ↗</a>}
          <a href={explorerAddr(ROUTER_V1)} target="_blank" rel="noreferrer">v1 {shortAddr(ROUTER_V1)} ↗</a>
          <a href={explorerTx(DEPLOY_TX)} target="_blank" rel="noreferrer">v1 deploy tx ↗</a>
        </p>
      </div>
    </section>
  )
}
