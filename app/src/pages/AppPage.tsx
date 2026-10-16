import { useEffect, useMemo, useState } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther, parseEther } from 'viem'
import { COIL_ROUTER, explorerAddr, MUSD } from '../lib/chain'
import { useBtcHistory, useGuard, useMarket, useRadar, useTrove, redemptionShield, type MarketState } from '../lib/live'
import {
  amountIn, fromWad, maxLeverage, planClose, planGuard, planOpen, WAD, type OpenPlan,
} from '../lib/math'
import { historicalTouchRate, realizedVol, touchProbability } from '../lib/risk'
import { fmtBtc, fmtCompact, fmtNum, fmtPct, fmtUsd, shortAddr } from '../lib/format'
import { useTweened } from '../lib/motion'
import { useCoilActions, type Step } from '../lib/actions'
import { FlowGraph } from '../components/FlowGraph'
import { Fan } from '../components/Fan'
import { Gauge, RadarStrip, ReplayChart, type ReplayWindow } from '../components/Instruments'

const EXAMPLE: MarketState = {
  price: 82_089n * WAD, reserveMusd: 102_589_167n * WAD, reserveBtc: 1_302n * WAD, feeBps: 30n, minNetDebt: 1800n * WAD,
  interestBps: 100, tcr: 2.95, recoveryMode: false, troves: 247, block: 0n, updatedAt: 0,
}

type Position = { coll: number; debt: number; source: 'live' | 'preview' }

export function AppPage() {
  const { address } = useAccount()
  const marketQ = useMarket()
  const m = marketQ.data ?? EXAMPLE
  const price = fromWad(m.price)
  const troveQ = useTrove(address)
  const trove = troveQ.data?.exists ? troveQ.data : undefined
  const guardQ = useGuard(trove ? address : undefined)
  const radarQ = useRadar(marketQ.data?.price)
  const hist = useBtcHistory()
  const actions = useCoilActions()

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
      <div className="wrap">
        <MarketBar m={m} live={!!marketQ.data} error={marketQ.isError} />
        <div className="app__grid" style={{ marginTop: 24 }}>
          <div className="stack">
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
                live={!!trove} guard={guardQ.data} actions={actions} />
            )}
            {position && hist.data && (
              <ReplayPanel closes={hist.data.closes} startDay={hist.data.startDay} stepDays={hist.data.stepDays}
                leverage={trove ? (position.coll * price) / (position.coll * price - position.debt) : lev} interestBps={m.interestBps} source={hist.data.source} />
            )}
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
        <h3 id="build-h">Build a position</h3>
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
          <div className="row"><span>Refunded buffer</span><span>{fmtNum(fromWad(plan.refund), 0)} MUSD</span></div>
        </div>

        {plan.status === 'below-min-debt' && <p className="note note--danger">MUSD needs at least 1,800 MUSD of debt. Deposit more BTC or raise the leverage.</p>}
        {plan.status === 'tight' && <p className="note note--danger">This would open under 115% after the swap. Coil keeps a 5% cushion over liquidation.</p>}
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
        <h3 id="manage-h">Your position</h3>
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
          <StepList step={actions.step} active={actions.busy === 'Deleverage'} labels={['Sign the adjustment', 'Send one transaction', 'Mezo confirms']} />
          <button className="btn btn--block" disabled={!!actions.busy || repay === 0n || !actions.ready}
            onClick={() => actions.deleverage(withdraw, repay, collAfter, debtAfter)}>
            {actions.busy === 'Deleverage' ? 'Working…' : 'Deleverage in one transaction'}
          </button>
        </div>
        <div className="field" style={{ borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
          <span className="mono muted">Close everything</span>
          <div className="rows">
            <div className="row"><span>Debt repaid (flash)</span><span>{fmtNum(fromWad(close.musdOwed))} MUSD</span></div>
            <div className="row"><span>BTC sold to the pool</span><span>{fmtBtc(fromWad(close.btcToPool), 4)}</span></div>
            <div className="row row--strong"><span>BTC back to you</span><span>{fmtBtc(fromWad(close.btcOut), 5)}</span></div>
          </div>
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
        <div className="panel__h"><h3>Position</h3><span className="pill" data-s="idle">Nothing yet</span></div>
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
        <h3 id="pos-h">{trove ? 'Your trove' : 'Preview of this plan'}</h3>
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
        <h3 id="risk-h">Liquidation odds</h3>
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
        <h3 id="radar-h">Redemption radar</h3>
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

function GuardPanel({ m, position, trigger, setTrigger, lo, hi, live, guard, actions }: {
  m: MarketState
  position: Position
  trigger: number
  setTrigger: (v: number) => void
  lo: number
  hi: number
  live: boolean
  guard?: import('../lib/live').GuardState
  actions: ReturnType<typeof useCoilActions>
}) {
  const [target, setTarget] = useState(1.6)
  const [days, setDays] = useState(30)
  const price = fromWad(m.price)
  const t = { coll: BigInt(Math.round(position.coll * 1e6)) * 10n ** 12n, debt: BigInt(Math.round(position.debt * 1e6)) * 10n ** 12n, status: 1, interestBps: m.interestBps }
  const g = planGuard(m, t, trigger, target, fromWad(m.minNetDebt))
  const pct = hi > lo ? ((trigger - lo) / (hi - lo)) * 100 : 0
  const armed = guard?.armed
  return (
    <section className="panel" aria-labelledby="guard-h">
      <div className="panel__h">
        <h3 id="guard-h">Guard · signed stop-loss</h3>
        {armed ? (
          <span className="pill" data-s={guard!.fresh ? (guard!.triggered ? 'danger' : 'ok') : 'watch'}>
            {guard!.fresh ? (guard!.triggered ? 'Triggered, waiting for a keeper' : `Armed at ${fmtUsd(fromWad(guard!.triggerPrice))}`) : 'Stale, sign again'}
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
            <div className="row"><span>Keeper bounty</span><span>0.30% of the BTC released</span></div>
          </div>
        ) : (
          <p className="note">{g.reason}</p>
        )}
        <p className="field__hint" style={{ margin: 0 }}>
          You sign one exact adjustment now. Coil stores it on-chain with the trigger; once MUSD's price feed is at or below it, any keeper can run it. Any other change to your trove makes the signature stale, so you re-arm after.
        </p>
        <StepList step={actions.step} active={actions.busy === 'Arm Guard'} labels={['Sign the deleverage', 'Store it with the trigger', 'Mezo confirms']} />
        <div className="cta-row">
          <button className="btn" disabled={!live || !g.ok || !!actions.busy || !actions.ready} onClick={() => actions.armGuard(g, 30, days)}>
            {actions.busy === 'Arm Guard' ? 'Working…' : armed ? 'Re-arm Guard' : 'Arm Guard'}
          </button>
          {armed && <button className="btn btn--ghost" disabled={!!actions.busy} onClick={() => actions.disarmGuard()}>Disarm</button>}
        </div>
        {!live && <p className="field__hint" style={{ margin: 0 }}>Open the position first; a Guard protects a live trove.</p>}
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
        <h3 id="replay-h">Replay through history</h3>
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

