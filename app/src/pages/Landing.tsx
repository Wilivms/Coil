import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { Wordmark } from '../components/Wordmark'
import { Rings } from '../components/Rings'
import { FlowGraph } from '../components/FlowGraph'
import { useBtcHistory, useMarket, type MarketState } from '../lib/live'
import { planOpen, fromWad, WAD } from '../lib/math'
import { fmtBtc, fmtCompact, fmtNum, fmtPct, fmtUsd } from '../lib/format'
import { realizedVol, touchProbability } from '../lib/risk'
import { reducedMotion } from '../lib/motion'

gsap.registerPlugin(ScrollTrigger)

/** Example market used until the first live read lands (shape of testnet on 16 Oct 2026). */
const EXAMPLE: MarketState = {
  price: 82_089n * WAD, reserveMusd: 102_589_167n * WAD, reserveBtc: 1_302n * WAD, feeBps: 30n, minNetDebt: 1800n * WAD,
  interestBps: 100, tcr: 2.95, recoveryMode: false, troves: 247, block: 0n, updatedAt: 0,
}

const LEVERS = [2, 3, 5]

export function Landing() {
  const marketQ = useMarket()
  const m = marketQ.data ?? EXAMPLE
  const live = !!marketQ.data
  const hist = useBtcHistory()
  const [lev, setLev] = useState(3)
  const plan = useMemo(() => planOpen(m, WAD, lev), [m, lev])
  const price = fromWad(m.price)
  const vol = hist.data ? realizedVol(hist.data.closes, hist.data.stepDays === 1 ? 30 : 8, hist.data.stepDays) : 0.5
  const p30 = touchProbability(price, plan.liqPrice, vol, 30 / 365)
  const manual = manualLoop(lev)

  useSmoothScroll()
  useReveals()

  const nodes = [
    { tag: 'Input', title: 'Your BTC', value: `${fmtBtc(fromWad(plan.deposit), 2)} BTC`, sub: 'sent with the transaction', fn: 'CoilRouter.coil{value}' },
    { tag: 'Flash swap', title: 'Borrow BTC from the pool', value: `+${fmtBtc(fromWad(plan.flashBtc), 3)} BTC`, sub: `MUSD/BTC pool · ${fmtCompact(fromWad(m.reserveBtc))} BTC deep`, fn: 'Pool.swap → hook()' },
    { tag: 'Your trove', title: 'Open it in your name', value: `${fmtBtc(fromWad(plan.totalColl), 3)} BTC`, sub: `${fmtCompact(fromWad(plan.compositeDebt))} MUSD debt · ${fmtPct(plan.icr, 0)} ratio`, fn: 'openTroveWithSignature (EIP-712)' },
    { tag: 'Settle', title: 'Repay the pool in MUSD', value: `${fmtCompact(fromWad(plan.musdIn))} MUSD`, sub: `${fmtNum(fromWad(plan.refund), 0)} MUSD buffer back to you`, fn: 'MUSD.transfer(pool)' },
  ]

  return (
    <main id="top">
      <section className="wrap hero" id="hero">
        <div>
          <div className="eyebrow mono"><span>Mezo Buildathon</span><span>Track 1 · DeFi</span><span>MUSD · BTC</span></div>
          <Wordmark trigger="#hero" />
          <h1 className="lede">Leveraged Bitcoin in one signature.</h1>
          <p className="sub">
            Coil opens a leveraged MUSD trove in a single transaction: it flash-borrows BTC from Mezo's own pool, opens the trove
            in your name and repays the pool with the MUSD the trove mints. Then it watches the position with you, and can
            deleverage it for you while you sleep.
          </p>
          <div className="cta-row">
            <a className="btn magnetic" href="#/app">Open the app <Arrow /></a>
            <a className="btn btn--ghost" href="#/pitch">Watch the pitch</a>
          </div>
        </div>
        <Rings layers={[1, ...(plan.flashBtc > 0n ? splitLayers(fromWad(plan.flashBtc)) : [])]}>
          <div>
            <div className="rings__big num">{lev.toFixed(2)}×</div>
            <div className="mono muted" style={{ marginTop: 6 }}>BTC exposure, 1 tx</div>
          </div>
        </Rings>
      </section>

      <LiveStrip m={m} live={live} plan1={plan.musdIn} />

      <section className="section" id="how">
        <div className="wrap">
          <div className="shead">
            <span className="mono">01 · The transaction</span>
            <h2 className="widen">One signature. One transaction. Four moves.</h2>
            <p>Numbers below are a live quote on Mezo testnet for 1 BTC. Your trove never leaves your address: Coil is only the recipient of what it needs to settle the flash swap.</p>
          </div>
          <FlowGraph
            title="coil(1 BTC)"
            nodes={nodes}
            pulseKey={lev}
            controls={
              <div className="seg-dark" role="group" aria-label="Leverage">
                {LEVERS.map((l) => (
                  <button key={l} aria-pressed={l === lev} onClick={() => setLev(l)}>{l}×</button>
                ))}
              </div>
            }
            footer={
              <>
                <span className="mono">Liquidation at {fmtUsd(plan.liqPrice)} ({fmtPct(plan.liqPrice / price - 1, 0)})</span>
                <span className="mono">Pool fee {(Number(m.feeBps) / 100).toFixed(2)}% · Borrow fee 0.10% · Fixed rate {(m.interestBps / 100).toFixed(2)}%</span>
              </>
            }
          />
          <div className="compare" style={{ marginTop: 48 }}>
            <div className="compare__col">
              <span className="mono muted">Looping by hand to {lev}×</span>
              <div className="compare__big countup" data-to={manual.txs}>{manual.txs}</div>
              <div className="txgrid" aria-hidden="true">
                {Array.from({ length: manual.txs }, (_, i) => <i key={i} className="on" />)}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                transactions: open, then borrow · approve · swap · deposit for each of {manual.loops} loops at 70% of each deposit.
                Each swap pays the pool fee again, and you are exposed between every step.
              </p>
            </div>
            <div className="compare__col compare__col--coil">
              <span className="mono muted">With Coil</span>
              <div className="compare__big countup" data-to={1}>1</div>
              <div className="txgrid" aria-hidden="true"><i className="acc" /></div>
              <p className="muted" style={{ margin: 0 }}>
                transaction, after one off-chain signature. One swap, sized exactly by the pool's own curve, settled atomically:
                if any step fails, nothing happens.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="guard" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="shead">
            <span className="mono">02 · What else it does</span>
            <h2 className="widen">A trove that looks after itself.</h2>
          </div>
          <div className="features">
            <div className="feature">
              <div className="feature__fig num">0 <small>clicks at 3 a.m.</small></div>
              <h3>Guard</h3>
              <p>
                Pre-sign a partial deleverage and a trigger price. When MUSD's own price feed reaches it, any keeper can run it
                for a 0.3% bounty: Coil flash-borrows MUSD, repays part of your debt and sells only the BTC it needs.
                You keep the position instead of losing it to liquidation.
              </p>
            </div>
            <div className="feature" id="risk">
              <div className="feature__fig num">{fmtPct(p30, 1)} <small>30-day touch odds at {lev}×</small></div>
              <h3>Risk cockpit</h3>
              <p>
                Liquidation odds from a first-passage model on realized volatility ({fmtPct(vol, 0)} a year), a Monte Carlo field
                of 220 price paths, and a replay of your leverage through every BTC drawdown since 2019.
              </p>
            </div>
            <div className="feature">
              <div className="feature__fig num">{m.troves} <small>troves read live</small></div>
              <h3>Redemption radar</h3>
              <p>
                MUSD redeems the lowest ratios first. Coil reads every trove on Mezo and tells you how much MUSD has to be
                redeemed before yours is touched, and how that changes with your leverage.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="ticker mono" aria-hidden="true">
        <div className="ticker__track">
          {[0, 1].map((k) => (
            <span key={k} style={{ display: 'inline-flex', gap: 48 }}>
              <span><em>MUSD</em>$1.00 peg</span>
              <span><em>Min ratio</em>110%</span>
              <span><em>Borrow fee</em>0.10%</span>
              <span><em>Redemption</em>0.75%</span>
              <span><em>Recovery mode</em>TCR &lt; 150%</span>
              <span><em>Pool</em>MUSD/BTC · {(Number(m.feeBps) / 100).toFixed(2)}%</span>
              <span><em>Oracle</em>Skip BTC/USD</span>
              <span><em>Chain</em>Mezo 31611</span>
            </span>
          ))}
        </div>
      </div>

      <section className="section">
        <div className="wrap">
          <div className="shead">
            <span className="mono">03 · Rules</span>
            <h2 className="widen">The rules the loop lives by.</h2>
          </div>
          <div className="rules">
            <div className="rule"><div className="rule__fig num">110%</div><div><h4>Liquidation</h4><p>Below a 110% ratio anyone can liquidate the trove and its collateral is gone. Coil refuses to open under 115% after price impact.</p></div></div>
            <div className="rule"><div className="rule__fig num">0.75%</div><div><h4>Redemption</h4><p>Holders redeem MUSD for BTC from the lowest ratios first. A tight loop is first in line; the radar shows how much cover you have.</p></div></div>
            <div className="rule"><div className="rule__fig num">150%</div><div><h4>Recovery mode</h4><p>If the whole system drops under 150%, borrowing rules tighten and closing is paused. Coil shows the system ratio live.</p></div></div>
            <div className="rule"><div className="rule__fig num">1,800</div><div><h4>Minimum debt</h4><p>A trove carries at least 1,800 MUSD of debt plus a 200 MUSD gas reserve. At 3× that means a deposit of roughly 0.012 BTC or more.</p></div></div>
          </div>
          <div className="cta-row" style={{ marginTop: 48 }}>
            <a className="btn magnetic" href="#/app">Open the app <Arrow /></a>
            <a className="btn btn--ghost" href="https://github.com/Wilivms/Coil" target="_blank" rel="noreferrer">Read the contracts</a>
          </div>
        </div>
      </section>
    </main>
  )
}

function LiveStrip({ m, live, plan1 }: { m: MarketState; live: boolean; plan1: bigint }) {
  const cells: [string, string][] = [
    ['BTC · MUSD oracle', fmtUsd(fromWad(m.price))],
    ['Pool depth', `${fmtCompact(fromWad(m.reserveBtc))} BTC`],
    ['Fixed borrow rate', `${(m.interestBps / 100).toFixed(2)}%`],
    ['System ratio', fmtPct(m.tcr, 0)],
    ['Open troves', String(m.troves)],
    ['1 BTC → 3× costs', `${fmtCompact(fromWad(plan1))} MUSD`],
  ]
  return (
    <div className="strip">
      <div className="wrap strip__in" style={{ paddingInline: 0 }}>
        {cells.map(([k, v], i) => (
          <div className="strip__cell" key={k}>
            <span className="mono">{i === 0 && <span className={'dot' + (live ? '' : ' dot--off')} />}{k}</span>
            <span className="strip__v">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Manual loop to reach `target` at 70% of each new deposit: 1 open + 3 tx per loop. */
function manualLoop(target: number) {
  let lev = 1, add = 1, loops = 0
  while (lev < target - 1e-9 && loops < 12) {
    add *= 0.7
    lev += add
    loops++
  }
  return { loops, txs: 1 + loops * 4 }
}

function splitLayers(flash: number) {
  // Show the flashed BTC as successive layers, the way a manual loop would have stacked them.
  const out: number[] = []
  let left = flash, a = 0.7
  while (left > 0.02 && out.length < 7) {
    const take = Math.min(left, a)
    out.push(take)
    left -= take
    a *= 0.7
  }
  if (left > 0) out.push(left)
  return out
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function useSmoothScroll() {
  useEffect(() => {
    if (reducedMotion()) return
    const lenis = new Lenis({ duration: 1.1, smoothWheel: true })
    lenis.on('scroll', ScrollTrigger.update)
    const raf = (t: number) => lenis.raf(t * 1000)
    gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a[href^="#"]') as HTMLAnchorElement | null
      if (!a) return
      const id = a.getAttribute('href')!
      if (id.startsWith('#/')) return
      const el = document.querySelector(id)
      if (el) {
        e.preventDefault()
        lenis.scrollTo(el as HTMLElement, { offset: -72 })
      }
    }
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('click', onClick)
      gsap.ticker.remove(raf)
      lenis.destroy()
    }
  }, [])
}

function useReveals() {
  const done = useRef(false)
  useEffect(() => {
    if (reducedMotion() || done.current) return
    done.current = true
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('.widen').forEach((h) => {
        gsap.fromTo(h, { '--w': 72 }, { '--w': 112, ease: 'none', scrollTrigger: { trigger: h, start: 'top 95%', end: 'top 45%', scrub: true } })
      })
      gsap.utils.toArray<HTMLElement>('.countup').forEach((el) => {
        const to = Number(el.dataset.to)
        const o = { v: 0 }
        ScrollTrigger.create({
          trigger: el, start: 'top 85%', once: true,
          onEnter: () => gsap.to(o, { v: to, duration: 1.2, ease: 'power3.out', onUpdate: () => (el.textContent = String(Math.round(o.v))) }),
        })
      })
      gsap.utils.toArray<HTMLElement>('.txgrid').forEach((g) => {
        gsap.from(g.children, { scale: 0, duration: 0.4, ease: 'back.out(2)', stagger: 0.03, scrollTrigger: { trigger: g, start: 'top 90%', once: true } })
      })
      gsap.utils.toArray<HTMLElement>('.feature, .rule').forEach((el) => {
        gsap.fromTo(el, { y: 28 }, { y: 0, ease: 'none', scrollTrigger: { trigger: el, start: 'top 100%', end: 'top 70%', scrub: true } })
      })
      document.querySelectorAll<HTMLElement>('.magnetic').forEach((b) => {
        b.addEventListener('mousemove', (e) => {
          const r = b.getBoundingClientRect()
          gsap.to(b, { x: (e.clientX - r.left - r.width / 2) * 0.25, y: (e.clientY - r.top - r.height / 2) * 0.35, duration: 0.4, ease: 'power3.out' })
        })
        b.addEventListener('mouseleave', () => gsap.to(b, { x: 0, y: 0, duration: 0.7, ease: 'elastic.out(1, 0.4)' }))
      })
    })
    return () => {
      ctx.revert()
      done.current = false
    }
  }, [])
}
