import { useLayoutEffect, useMemo, useRef, type ComponentType } from 'react'
import gsap from 'gsap'
import { SplitText } from 'gsap/SplitText'
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'
import { TextPlugin } from 'gsap/TextPlugin'
import { CustomEase } from 'gsap/CustomEase'
import type { MarketState, Radar } from '../lib/live'
import { fromWad, type OpenPlan } from '../lib/math'
import { fmtCompact, fmtNum, fmtUsd } from '../lib/format'
import { mulberry32, simulate, touchProbability } from '../lib/risk'
import { reducedMotion } from '../lib/motion'

gsap.registerPlugin(SplitText, ScrambleTextPlugin, DrawSVGPlugin, MotionPathPlugin, TextPlugin, CustomEase)
CustomEase.create('coil', 'M0,0 C0.18,0.9 0.25,1.04 1,1')

export type DeckData = { m: MarketState; plan: OpenPlan; radar?: Radar; router: string; live: boolean }
type SceneProps = { data: DeckData; frozen?: boolean; onExit?: (to?: string) => void; mode?: 'intro' | 'deck' }
export type Scene = {
  id: string
  title: string
  theme: 'dark' | 'light' | 'accent'
  duration: number
  transition: 'iris' | 'wipe-up' | 'wipe-left' | 'split' | 'diag' | 'fade'
  Component: ComponentType<SceneProps>
}

/** Build a scene timeline inside a GSAP context; frozen or reduced-motion scenes jump to their end state. */
function useScene(root: React.RefObject<HTMLElement>, frozen: boolean | undefined, build: (tl: gsap.core.Timeline) => void, deps: unknown[] = []) {
  useLayoutEffect(() => {
    if (!root.current) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: frozen ? 0 : 0.45 })
      build(tl)
      if (frozen || reducedMotion()) tl.progress(1)
    }, root)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** Lines rise out of a mask, word by word. */
function riseLines(tl: gsap.core.Timeline, sel: string, at: gsap.Position = 0, stagger = 0.08) {
  const els = gsap.utils.toArray<HTMLElement>(sel)
  els.forEach((el, i) => {
    const s = SplitText.create(el, { type: 'lines,words', mask: 'lines', linesClass: 'p-split-line' })
    tl.from(s.words, { yPercent: 115, duration: 1.05, ease: 'coil', stagger: 0.035 }, i === 0 ? at : `<${stagger * 4}`)
  })
}

const countTo = (tl: gsap.core.Timeline, el: Element | null, to: number, fmt: (v: number) => string, at: gsap.Position, dur = 1.4, from = 0) => {
  if (!el) return
  const o = { v: from }
  tl.to(o, { v: to, duration: dur, ease: 'power3.out', onUpdate: () => { el.textContent = fmt(o.v) } }, at)
}

/* =============================================================== 1 · asleep */

function Asleep({ frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const morph = useRef({ t: 0, spin: 0 })

  useLayoutEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rand = mulberry32(3)
    const N = 760
    const pts = Array.from({ length: N }, (_, i) => ({
      x: rand(), y: rand(), vx: (rand() - 0.5) * 0.0006, vy: (rand() - 0.5) * 0.0006,
      a: (i / N) * Math.PI * 2 * 3 + rand() * 0.4, r: 0.18 + (i / N) * 0.16 + (rand() - 0.5) * 0.012,
      hot: rand() < 0.18, s: 0.6 + rand() * 1.6,
    }))
    let raf = 0
    const draw = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (el.width !== w * dpr) { el.width = w * dpr; el.height = h * dpr }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const t = morph.current.t
      const cx = w > 860 ? w * 0.76 : w * 0.5
      const cy = w > 860 ? h * 0.52 : h * 0.68
      const R = Math.min(w, h) * (w > 860 ? 0.95 : 0.8)
      for (const p of pts) {
        p.x += p.vx * (1 - t); p.y += p.vy * (1 - t)
        if (p.x < 0 || p.x > 1) p.vx *= -1
        if (p.y < 0 || p.y > 1) p.vy *= -1
        const ang = p.a + morph.current.spin * (p.hot ? 1.4 : 1)
        const tx = cx + Math.cos(ang) * p.r * R, ty = cy + Math.sin(ang) * p.r * R
        const x = p.x * w + (tx - p.x * w) * t, y = p.y * h + (ty - p.y * h) * t
        ctx.fillStyle = p.hot ? `rgba(247,147,26,${0.45 + 0.55 * t})` : `rgba(237,237,234,${0.16 + 0.3 * t})`
        ctx.beginPath(); ctx.arc(x, y, p.s * (1 + t * 0.4), 0, Math.PI * 2); ctx.fill()
      }
    }
    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    if (frozen || reducedMotion()) { morph.current.t = 1; draw() } else raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  useScene(root, frozen, (tl) => {
    tl.from('.p-eyebrow', { opacity: 0, x: -20, duration: 0.8 })
    riseLines(tl, '.s1-h', 0.1)
    tl.to(morph.current, { t: 1, duration: 3.2, ease: 'expo.inOut' }, 1.2)
      .to(morph.current, { spin: 1.2, duration: 6, ease: 'none' }, 1.2)
      .to('.s1-sleep', { duration: 1.4, scrambleText: { text: 'Most of it is asleep.', chars: '₿01·×', speed: 0.5 } }, 2.0)
      .from('.s1-sub', { opacity: 0, y: 16, duration: 0.9 }, 3.1)
  })

  return (
    <section className="scene scene--dark" ref={root}>
      <canvas ref={cv} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} aria-hidden="true" />
      <div className="scene__in">
        <div className="p-eyebrow"><span>Mezo Buildathon</span><span>Track 1 · DeFi</span><span>MUSD × BTC</span></div>
        <h1 className="p-h s1-h">Bitcoin is the best collateral there is.</h1>
        <p className="p-h s1-sleep" style={{ color: 'var(--p-acc)', fontSize: 'clamp(30px, 4.6vw, 72px)' }}>&nbsp;</p>
        <p className="p-sub s1-sub">More than 100 million people hold BTC. Mezo lets them borrow MUSD against it without selling. Coil makes that borrowing productive.</p>
      </div>
    </section>
  )
}

/* =============================================================== 2 · the loop */

const LOOP_STEPS = ['open trove', 'borrow MUSD', 'approve', 'swap → BTC', 'deposit BTC']

function Loop({ frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  // Archimedean spiral: one turn per manual loop.
  const spiral = useMemo(() => {
    let d = ''
    for (let i = 0; i <= 600; i++) {
      const a = (i / 600) * Math.PI * 2 * 6
      const r = 8 + (i / 600) * 150
      d += `${i ? 'L' : 'M'}${(170 + Math.cos(a) * r).toFixed(1)} ${(170 + Math.sin(a) * r).toFixed(1)}`
    }
    return d
  }, [])
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s2-h', 0)
    tl.from('.s2-sub', { opacity: 0, y: 14, duration: 0.8 }, 0.5)
    const cells = gsap.utils.toArray<HTMLElement>('.p-txgrid i')
    tl.from(cells, { scale: 0, opacity: 0, duration: 0.35, ease: 'back.out(3)', stagger: 0.11 }, 1.0)
    const n = root.current!.querySelector('.s2-n')
    countTo(tl, n, 25, (v) => String(Math.round(v)).padStart(2, '0'), 1.0, cells.length * 0.11, 0)
    const step = root.current!.querySelector('.s2-step')
    cells.forEach((_, i) => tl.set(step, { textContent: i === 0 ? LOOP_STEPS[0] : LOOP_STEPS[1 + ((i - 1) % 4)] }, 1.0 + i * 0.11))
    tl.to('.p-meter i', { scaleX: 1, duration: cells.length * 0.11, ease: 'none' }, 1.0)
      .fromTo('.s2-spiral', { drawSVG: '0%' }, { drawSVG: '100%', duration: cells.length * 0.11, ease: 'none' }, 1.0)
      .from('.s2-tag', { opacity: 0, y: 10, duration: 0.6 }, '>-0.1')
  })
  return (
    <section className="scene scene--light" ref={root}>
      <div className="scene__in">
        <div className="p-row">
          <div style={{ display: 'grid', gap: 24, minWidth: 0 }}>
            <div className="p-eyebrow"><span>The problem</span></div>
            <h2 className="p-h s2-h">Leverage on Mezo today is a <em>loop</em>.</h2>
            <p className="p-sub s2-sub">To reach 3× by hand you open a trove, then borrow, approve, swap and deposit. Again. And again. Six swaps, six fees, exposed between every step.</p>
            <div className="p-txgrid" aria-hidden="true">
              {Array.from({ length: 25 }, (_, i) => <i key={i} className={i === 0 ? 'open' : ''} />)}
            </div>
            <div className="p-meter" aria-hidden="true"><i /></div>
            <div style={{ display: 'flex', gap: 18, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="p-big s2-n" style={{ fontSize: 'clamp(54px, 7vw, 110px)' }}>25</span>
              <span className="p-mono" style={{ fontSize: 14, opacity: 0.7 }}>transactions · now: <span className="s2-step" style={{ color: 'var(--p-acc-ink)' }}>deposit BTC</span></span>
            </div>
          </div>
          <svg className="p-svg s2-spiral-wrap" viewBox="0 0 340 340" aria-hidden="true" style={{ maxWidth: 420, justifySelf: 'center' }}>
            <path className="s2-spiral" d={spiral} fill="none" stroke="#111113" strokeWidth="2" strokeLinecap="round" />
            <circle cx="170" cy="170" r="6" fill="#f7931a" />
            <text className="s2-tag" x="170" y="335" textAnchor="middle" style={{ font: '500 11px var(--f-mono)', letterSpacing: '0.1em', fill: '#5c5c65' }}>ONE TURN PER LOOP</text>
          </svg>
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 3 · three primitives */

function Primitives({ frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s3-h', 0)
    tl.from('.p-card', {
      rotateY: -75, rotateX: 18, z: -260, opacity: 0, transformOrigin: '0% 50%', duration: 1.3, ease: 'expo.out', stagger: 0.18,
    }, 0.55)
      .from('.p-card .draw', { drawSVG: '0%', duration: 1.2, ease: 'power2.inOut', stagger: 0.06 }, 1.1)
    gsap.utils.toArray<HTMLElement>('.p-card code').forEach((c, i) => {
      tl.from(c, { duration: 1, scrambleText: { text: c.textContent ?? '', chars: '0123456789abcdef', speed: 0.6 } }, 1.4 + i * 0.18)
    })
    tl.from('.s3-foot', { opacity: 0, y: 12, duration: 0.7 }, 2.4)
  })
  return (
    <section className="scene scene--dark scene--dots" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>The insight</span></div>
        <h2 className="p-h s3-h">Mezo already ships the <em>three pieces</em>.</h2>
        <div className="p-cards">
          <div className="p-card">
            <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <path className="draw" d="M10 24 H46 L38 16" stroke="#f7931a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path className="draw" d="M54 40 H18 L26 48" stroke="#ededea" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3>Flash swaps</h3>
            <p>Mezo Pools send tokens first, call you back, and only check they were paid at the end of the transaction.</p>
            <code>Pool.swap → hook()</code>
          </div>
          <div className="p-card">
            <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <path className="draw" d="M8 46 C 16 30, 22 52, 30 38 S 44 26, 52 40" stroke="#f7931a" strokeWidth="3" strokeLinecap="round" />
              <path className="draw" d="M10 54 H54" stroke="#ededea" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <h3>Signed troves</h3>
            <p>MUSD lets a contract open, adjust or close a trove for a borrower who signed. The trove stays theirs.</p>
            <code>openTroveWithSignature</code>
          </div>
          <div className="p-card">
            <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <circle className="draw" cx="32" cy="32" r="22" stroke="#f7931a" strokeWidth="3" />
              <path className="draw" d="M26 20 V44 M26 22 H36 a5 5 0 0 1 0 10 H26 M26 32 H38 a6 6 0 0 1 0 12 H26" stroke="#ededea" strokeWidth="2.5" strokeLinejoin="round" />
            </svg>
            <h3>Native BTC</h3>
            <p>BTC is the gas coin and an ERC-20 over the same balance, so flashed BTC goes straight in as collateral.</p>
            <code>0x7b7c…0000</code>
          </div>
        </div>
        <p className="p-sub s3-foot">Wire them together and leverage stops being a loop.</p>
      </div>
    </section>
  )
}

/* =============================================================== 4 · reveal */

function Reveal({ frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  useScene(root, frozen, (tl) => {
    const chars = gsap.utils.toArray<HTMLElement>('.s4-word span')
    tl.fromTo(chars, { '--cw': 62, yPercent: 105 }, { '--cw': 125, yPercent: 0, duration: 1.5, ease: 'expo.out', stagger: 0.08 }, 0)
      .to(root.current, { backgroundColor: '#f4f4f1', color: '#111113', duration: 1.1, ease: 'power2.inOut' }, 1.2)
      .fromTo('.s4-dot', { scale: 1 }, { scale: 1.25, duration: 0.5, yoyo: true, repeat: 3, ease: 'sine.inOut', transformOrigin: '50% 50%' }, 1.6)
    riseLines(tl, '.s4-tag', 1.6)
    tl.from('.s4-meta span', { opacity: 0, y: 10, stagger: 0.12, duration: 0.6 }, 2.4)
  })
  return (
    <section className="scene scene--accent" ref={root} style={{ alignContent: 'center' }}>
      <div className="scene__in" style={{ justifyItems: 'start' }}>
        <div className="word s4-word" style={{ fontSize: 'clamp(110px, 24vw, 380px)' }} aria-label="Coil">
          <span>C</span><span>O</span><span>I</span><span>L</span><span className="s4-dot" style={{ color: '#f7931a' }}>.</span>
        </div>
        <h2 className="p-h s4-tag" style={{ fontWeight: 520, maxWidth: '22ch', fontVariationSettings: "'wdth' 88" }}>Leveraged Bitcoin in one signature.</h2>
        <div className="p-eyebrow s4-meta" style={{ opacity: 1 }}><span>1 signature</span><span>1 transaction</span><span>trove stays yours</span></div>
      </div>
    </section>
  )
}

/* =============================================================== 5 · the transaction */

function Transaction({ data, frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const p = data.plan
  const nodes = [
    { x: 30, tag: 'INPUT', title: 'Your BTC', v: fromWad(p.deposit), fmt: (v: number) => `${v.toFixed(2)} BTC` },
    { x: 330, tag: 'FLASH SWAP', title: 'Pool lends BTC', v: fromWad(p.flashBtc), fmt: (v: number) => `+${v.toFixed(3)} BTC` },
    { x: 630, tag: 'YOUR TROVE', title: 'Opened in your name', v: fromWad(p.totalColl), fmt: (v: number) => `${v.toFixed(3)} BTC` },
    { x: 930, tag: 'SETTLE', title: 'Pool repaid in MUSD', v: fromWad(p.musdIn), fmt: (v: number) => `${fmtCompact(v)} MUSD` },
  ]
  const W = 240, H = 150, Y = 40
  const wires = nodes.slice(0, -1).map((n, i) => {
    const a = n.x + W, b = nodes[i + 1].x, y = Y + H / 2
    return `M${a} ${y} C${a + 30} ${y} ${b - 30} ${y} ${b} ${y}`
  })
  const track = `M${nodes[0].x + W / 2} ${Y + H / 2} L${nodes[3].x + W / 2} ${Y + H / 2}`
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s5-h', 0)
    tl.from('.s5-node', { scale: 0.6, opacity: 0, transformOrigin: '50% 50%', duration: 0.7, ease: 'back.out(2)', stagger: 0.55 }, 0.6)
    gsap.utils.toArray<SVGPathElement>('.s5-wire').forEach((w, i) => {
      tl.fromTo(w, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.5, ease: 'power2.inOut' }, 0.95 + i * 0.55)
    })
    gsap.utils.toArray<SVGTextElement>('.s5-val').forEach((t, i) => {
      countTo(tl, t, nodes[i].v, nodes[i].fmt, 0.75 + i * 0.55, 0.9)
    })
    tl.to('.s5-pulse', { motionPath: { path: '.s5-track', align: '.s5-track', alignOrigin: [0.5, 0.5] }, duration: 2.2, ease: 'power1.inOut', opacity: 1 }, 3.0)
      .to('.s5-pulse', { opacity: 0, duration: 0.3 }, '>')
    const big = root.current!.querySelector('.s5-big')
    countTo(tl, big, 1, (v) => String(Math.max(1, Math.round(v))), 3.2, 2.0, 25)
    tl.from('.s5-cap', { opacity: 0, y: 10, duration: 0.6 }, 4.4)
  })
  return (
    <section className="scene scene--dark scene--dots" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>How it works</span><span>live quote · 1 BTC at 3×</span></div>
        <h2 className="p-h s5-h">Four moves. <em>One transaction.</em></h2>
        <svg className="p-svg" viewBox="0 0 1200 230" aria-label="Coil transaction: deposit, flash swap, open trove, settle">
          <path className="s5-track" d={track} fill="none" stroke="none" />
          {wires.map((d, i) => (
            <g key={i}>
              <path d={d} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
              <path className="s5-wire" d={d} fill="none" stroke="#f7931a" strokeWidth="2" />
            </g>
          ))}
          {nodes.map((n, i) => (
            <g key={i} className="s5-node">
              <rect x={n.x} y={Y} width={W} height={H} rx="10" fill="#17171a" stroke="#2a2a2f" />
              <text x={n.x + 18} y={Y + 30} style={{ font: '500 11px var(--f-mono)', letterSpacing: '0.12em', fill: '#8f8f98' }}>{n.tag}</text>
              <text x={n.x + 18} y={Y + 62} style={{ font: '650 19px var(--f-display)', fill: '#ededea' }}>{n.title}</text>
              <text className="s5-val" x={n.x + 18} y={Y + 112} style={{ font: '500 26px var(--f-mono)', letterSpacing: '-0.02em', fill: i === 3 ? '#f7931a' : '#ededea' }}>{n.fmt(n.v)}</text>
              <circle cx={n.x} cy={Y + H / 2} r="5" fill="#0c0c0e" stroke="#f7931a" strokeWidth="2" />
              <circle cx={n.x + W} cy={Y + H / 2} r="5" fill="#0c0c0e" stroke="#f7931a" strokeWidth="2" />
            </g>
          ))}
          <circle className="s5-pulse" r="9" fill="#f7931a" opacity="0" style={{ filter: 'drop-shadow(0 0 12px #f7931a)' }} />
        </svg>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 22, flexWrap: 'wrap' }}>
          <span className="p-big s5-big" style={{ color: 'var(--p-acc)' }}>1</span>
          <span className="p-sub s5-cap" style={{ opacity: 0.85 }}>transaction instead of 25. One swap, priced by the pool's own curve. If any step fails, nothing happens.</span>
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 6 · guard */

function Guard({ data, frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const s0 = fromWad(data.m.price)
  const liq = data.plan.liqPrice || s0 * 0.73
  const trigger = liq + (s0 - liq) * 0.42
  const W = 640, H = 360, pl = 10, pr = 10, pt = 20, pb = 20
  const series = [1, 0.97, 0.985, 0.95, 0.93, 0.945, 0.91, 0.885, 0.9, 0.87, 0.855, 0.875, 0.9, 0.93, 0.95, 0.965]
  const lo = liq * 0.92, hi = s0 * 1.04
  const X = (i: number) => pl + (i / (series.length - 1)) * (W - pl - pr)
  const Y = (v: number) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb)
  const pts = series.map((f, i) => [X(i), Y(s0 * f)] as const)
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
  // Where the path first crosses the trigger, as a share of its length.
  let cross = 0.5
  for (let i = 1; i < series.length; i++) if (s0 * series[i] <= trigger) { cross = (i - 0.5) / (series.length - 1); break }
  const ghost = `M${X(8)} ${Y(s0 * 0.9)} L${X(10)} ${Y(liq * 0.99)} L${X(12)} ${Y(liq * 0.96)}`
  const crAtTrigger = (trigger / liq) * 1.1
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s6-h', 0)
    tl.from('.s6-sub', { opacity: 0, y: 12, duration: 0.7 }, 0.5)
      .from('.s6-line', { scaleX: 0, transformOrigin: '0% 50%', duration: 0.8, ease: 'expo.out', stagger: 0.15 }, 0.7)
      .from('.s6-lab', { opacity: 0, duration: 0.4, stagger: 0.15 }, 1.1)
      .fromTo('.s6-price', { drawSVG: '0%' }, { drawSVG: '100%', duration: 4, ease: 'none' }, 1.3)
      .to('.s6-dot', { motionPath: { path: '.s6-price', align: '.s6-price', alignOrigin: [0.5, 0.5] }, duration: 4, ease: 'none' }, 1.3)
      .fromTo('.s6-ring', { scale: 0, opacity: 1, transformOrigin: '50% 50%' }, { scale: 4, opacity: 0, duration: 1, ease: 'expo.out' }, 1.3 + 4 * cross)
      .from('.s6-fire', { opacity: 0, y: 8, duration: 0.5 }, 1.3 + 4 * cross)
      .fromTo('.s6-ghost', { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.2, ease: 'power2.in' }, 1.3 + 4 * cross + 0.2)
    const cr = root.current!.querySelector('.s6-cr')
    countTo(tl, cr, 160, (v) => `${Math.round(v)}%`, 1.3 + 4 * cross + 0.1, 1.4, crAtTrigger * 100)
  })
  return (
    <section className="scene scene--dark" ref={root}>
      <div className="scene__in">
        <div className="p-row">
          <div style={{ display: 'grid', gap: 22, minWidth: 0 }}>
            <div className="p-eyebrow"><span>Guard</span><span>signed stop-loss</span></div>
            <h2 className="p-h s6-h">A trove that defends <em>itself</em>.</h2>
            <p className="p-sub s6-sub">Sign one partial deleverage and a trigger price. When MUSD's own price feed reaches it, any keeper runs it for a 0.3% bounty. Coil flash-borrows MUSD, repays part of the debt and sells only the BTC it needs.</p>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <div><div className="p-eyebrow">ratio after guard</div><div className="p-big s6-cr" style={{ fontSize: 'clamp(48px, 6vw, 96px)', color: 'var(--p-acc)' }}>160%</div></div>
              <div><div className="p-eyebrow">liquidation</div><div className="p-big" style={{ fontSize: 'clamp(48px, 6vw, 96px)', color: 'var(--p-red)', opacity: 0.85 }}>110%</div></div>
            </div>
          </div>
          <svg className="p-svg" viewBox={`0 0 ${W} ${H}`} aria-label="BTC falls to the Guard trigger; Guard deleverages before liquidation">
            <line className="s6-line" x1={pl} x2={W - pr} y1={Y(s0)} y2={Y(s0)} stroke="rgba(237,237,234,0.35)" />
            <line className="s6-line" x1={pl} x2={W - pr} y1={Y(trigger)} y2={Y(trigger)} stroke="#f7931a" strokeDasharray="7 5" strokeWidth="1.5" />
            <line className="s6-line" x1={pl} x2={W - pr} y1={Y(liq)} y2={Y(liq)} stroke="#ff6a5c" strokeDasharray="3 4" strokeWidth="1.5" />
            <text className="s6-lab" x={W - pr} y={Y(s0) - 8} textAnchor="end" style={{ font: '11px var(--f-mono)', fill: '#8f8f98' }}>today {fmtUsd(s0)}</text>
            <text className="s6-lab" x={W - pr} y={Y(trigger) - 8} textAnchor="end" style={{ font: '11px var(--f-mono)', fill: '#f7931a' }}>guard {fmtUsd(trigger)}</text>
            <text className="s6-lab" x={W - pr} y={Y(liq) + 18} textAnchor="end" style={{ font: '11px var(--f-mono)', fill: '#ff6a5c' }}>liquidation {fmtUsd(liq)}</text>
            <path className="s6-ghost" d={ghost} fill="none" stroke="#ff6a5c" strokeWidth="1.5" strokeDasharray="4 5" opacity="0.6" />
            <path className="s6-price" d={d} fill="none" stroke="#ededea" strokeWidth="2.5" strokeLinejoin="round" />
            <circle className="s6-ring" cx={X(cross * (series.length - 1))} cy={Y(trigger)} r="10" fill="none" stroke="#f7931a" strokeWidth="2" />
            <circle className="s6-dot" r="6" fill="#f7931a" />
            <text className="s6-fire" x={X(cross * (series.length - 1)) + 14} y={Y(trigger) + 24} style={{ font: '500 12px var(--f-mono)', fill: '#f7931a', letterSpacing: '0.06em' }}>GUARD FIRES · keeper +0.3%</text>
          </svg>
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 7 · risk */

function Risk({ data, frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const prog = useRef({ v: 0 })
  const s0 = fromWad(data.m.price)
  const liq = data.plan.liqPrice || s0 * 0.73
  const sigma = 0.5
  const sim = useMemo(() => simulate(s0, sigma, 30, 260, liq, 21), [s0, liq])
  const p30 = touchProbability(s0, liq, sigma, 30 / 365)
  const mc = sim.breached.reduce((a, b) => a + b, 0) / sim.breached.length

  useLayoutEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let raf = 0
    const finals = sim.paths.map((p) => p[p.length - 1]).sort((a, b) => a - b)
    const lo = Math.min(liq * 0.88, finals[5]), hi = Math.max(s0 * 1.2, finals[finals.length - 6])
    const draw = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (el.width !== w * dpr) { el.width = w * dpr; el.height = h * dpr }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const X = (d: number) => (d / 30) * w
      const Y = (v: number) => (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * h
      const k = prog.current.v
      const nPaths = Math.floor(k * sim.paths.length)
      const days = Math.max(1, Math.floor(Math.min(1, k * 1.6) * 30))
      for (let i = 0; i < nPaths; i++) {
        const p = sim.paths[i], bd = sim.breachDay[i]
        ctx.lineWidth = 1
        ctx.strokeStyle = bd >= 0 && bd <= days ? 'rgba(255,106,92,0.5)' : 'rgba(237,237,234,0.13)'
        ctx.beginPath()
        for (let d = 0; d <= days; d++) (d ? ctx.lineTo : ctx.moveTo).call(ctx, X(d), Y(p[d]))
        ctx.stroke()
      }
      ctx.setLineDash([3, 4]); ctx.strokeStyle = '#ff6a5c'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(0, Y(liq)); ctx.lineTo(w, Y(liq)); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = '#ff6a5c'; ctx.font = '11px "Martian Mono Variable", monospace'
      ctx.fillText('liquidation ' + fmtUsd(liq), 8, Y(liq) - 8)
    }
    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    if (frozen || reducedMotion()) { prog.current.v = 1; draw() } else raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [sim, s0, liq, frozen])

  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s7-h', 0)
    tl.to(prog.current, { v: 1, duration: 4.2, ease: 'power1.inOut' }, 0.5)
    countTo(tl, root.current!.querySelector('.s7-p'), p30 * 100, (v) => v.toFixed(1) + '%', 1.0, 2.4)
    countTo(tl, root.current!.querySelector('.s7-mc'), mc * 100, (v) => v.toFixed(1) + '%', 1.4, 3.6)
    tl.to('.s7-f', { duration: 2.6, text: { value: 'P(τ ≤ T) = Φ((ln L/S − νT) / σ√T) + (L/S)^(2ν/σ²) · Φ((ln L/S + νT) / σ√T)' }, ease: 'none' }, 1.6)
      .from('.s7-sub', { opacity: 0, y: 10, duration: 0.6 }, 2.2)
  })
  return (
    <section className="scene scene--dark" ref={root}>
      <div className="scene__in">
        <div className="p-row" style={{ ['--cols' as string]: '1fr 1.2fr' }}>
          <div style={{ display: 'grid', gap: 22, minWidth: 0 }}>
            <div className="p-eyebrow"><span>Risk cockpit</span><span>3× · 30 days · σ 50%</span></div>
            <h2 className="p-h s7-h">Odds, <em>not vibes</em>.</h2>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <div><div className="p-eyebrow">first-passage model</div><div className="p-big s7-p" style={{ fontSize: 'clamp(44px, 5.5vw, 88px)' }}>{(p30 * 100).toFixed(1)}%</div></div>
              <div><div className="p-eyebrow">Monte Carlo, 260 paths</div><div className="p-big s7-mc" style={{ fontSize: 'clamp(44px, 5.5vw, 88px)', color: 'var(--p-red)' }}>{(mc * 100).toFixed(1)}%</div></div>
            </div>
            <div className="p-formula s7-f" aria-label="First-passage probability formula" />
            <p className="p-sub s7-sub">Plus a replay of your leverage through every BTC drawdown since 2019, and the share of historical windows that would have liquidated you.</p>
          </div>
          <canvas ref={cv} className="p-canvas" aria-label="Monte Carlo price paths with liquidation barrier" />
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 8 · radar */

function RadarScene({ data, frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const troves = useMemo(() => {
    if (data.radar?.troves.length) return data.radar.troves.filter((t) => Number.isFinite(t.cr)).map((t) => ({ cr: t.cr, debt: t.debt }))
    const r = mulberry32(5)
    return Array.from({ length: data.m.troves || 247 }, () => ({ cr: 1.12 + Math.pow(r(), 1.6) * 4, debt: 2000 + Math.pow(r(), 3) * 400_000 })).sort((a, b) => a.cr - b.cr)
  }, [data.radar, data.m.troves])
  const maxLog = Math.max(...troves.map((t) => Math.log10(t.debt)))
  const crOf = (lev: number) => (lev / (lev - 1)) / 1.006
  const posOf = (cr: number) => {
    let i = 0, ahead = 0
    for (const t of troves) { if (t.cr < cr && t.cr >= 1.1) { i++; ahead += Math.max(0, t.debt - 200) } else if (t.cr < cr) i++ }
    return { i, ahead }
  }
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s8-h', 0)
    tl.from('.p-radar i', { scaleY: 0, duration: 0.7, ease: 'power3.out', stagger: { amount: 1.2, from: 'start' } }, 0.5)
    const you = root.current!.querySelector<HTMLElement>('.you')!
    const levEl = root.current!.querySelector('.s8-lev')!
    const aheadEl = root.current!.querySelector('.s8-ahead')!
    const bars = root.current!.querySelectorAll<HTMLElement>('.p-radar i')
    const o = { lev: 1.6 }
    const paint = () => {
      const { i, ahead } = posOf(crOf(o.lev))
      you.style.left = `${(i / troves.length) * 100}%`
      levEl.textContent = o.lev.toFixed(1) + '×'
      aheadEl.textContent = fmtCompact(ahead)
      bars.forEach((b, k) => b.classList.toggle('ahead', k < i))
    }
    paint()
    tl.from(you, { opacity: 0, duration: 0.4 }, 1.6)
      .to(o, { lev: 6, duration: 3.4, ease: 'power2.inOut', onUpdate: paint }, 2.0)
      .from('.s8-sub', { opacity: 0, y: 10, duration: 0.6 }, 2.4)
  }, [troves])
  return (
    <section className="scene scene--light" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>Redemption radar</span><span>{data.radar ? `${troves.length} live troves on Mezo testnet` : 'troves on Mezo testnet'}</span></div>
        <h2 className="p-h s8-h">Know your place in the <em>redemption queue</em>.</h2>
        <div className="p-radar" aria-hidden="true">
          {troves.map((t, i) => <i key={i} style={{ height: `${12 + (88 * Math.log10(t.debt)) / maxLog}%` }} />)}
          <span className="you" />
        </div>
        <div style={{ display: 'flex', gap: 36, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div><div className="p-eyebrow">leverage</div><div className="p-big s8-lev" style={{ fontSize: 'clamp(44px, 5.5vw, 88px)' }}>1.6×</div></div>
          <div><div className="p-eyebrow">MUSD redeemed before you</div><div className="p-big s8-ahead" style={{ fontSize: 'clamp(44px, 5.5vw, 88px)', color: 'var(--p-acc-ink)' }}>—</div></div>
          <p className="p-sub s8-sub" style={{ maxWidth: '40ch' }}>MUSD redeems the lowest ratios first. Coil reads every trove and shows how much cover you have, live, as you move the leverage.</p>
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 9 · proof */

function Proof({ data, frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const lines: [string, string][] = [
    ['dim', '$ forge test --fork-url mezo_testnet'],
    ['ok', '[PASS] test_fork_coilThenUnwind()   real MUSD + real MUSD/BTC pool'],
    ['ok', '22 passed · 0 failed · fuzzed open → close round trips'],
    ['dim', '$ forge script Deploy.s.sol --broadcast'],
    ['acc', `✓ CoilRouter ${data.router}`],
    ['dim', `$ coil status --live`],
    ['', `BTC ${fmtUsd(fromWad(data.m.price))} · pool ${fmtCompact(fromWad(data.m.reserveBtc))} BTC · TCR ${Math.round(data.m.tcr * 100)}% · block ${data.m.block ? fmtNum(Number(data.m.block)) : '—'}`],
  ]
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s9-h', 0)
    tl.from('.p-term', { y: 40, opacity: 0, rotateX: 12, transformPerspective: 900, duration: 0.9, ease: 'expo.out' }, 0.3)
    gsap.utils.toArray<HTMLElement>('.p-term .l').forEach((el, i) => {
      const text = lines[i][1]
      el.textContent = ''
      if (lines[i][0] === 'acc') tl.to(el, { duration: 1.1, scrambleText: { text, chars: '0123456789abcdefABCDEF', speed: 0.8, revealDelay: 0.3 } }, '>0.15')
      else tl.to(el, { duration: Math.min(1.1, text.length * 0.022), text: { value: text }, ease: 'none' }, '>0.12')
    })
  }, [data.router])
  return (
    <section className="scene scene--dark scene--dots" ref={root}>
      <div className="scene__in">
        <div className="p-row" style={{ ['--cols' as string]: '1fr 1.15fr' }}>
          <div style={{ display: 'grid', gap: 20 }}>
            <div className="p-eyebrow"><span>Proof</span></div>
            <h2 className="p-h s9-h" style={{ fontSize: 'clamp(34px, 4.6vw, 72px)' }}>Live on Mezo testnet. Tested against <em>the real thing</em>.</h2>
          </div>
          <div className="p-term" role="log" aria-label="Test and deployment output">
            {lines.map(([cls, text], i) => <div key={i} className={'l ' + cls}>{text}</div>)}
            <span className="caret" />
          </div>
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 10 · model & roadmap */

function Model({ frozen }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  useScene(root, frozen, (tl) => {
    riseLines(tl, '.s10-h', 0)
    tl.from('.p-stat', { y: 30, opacity: 0, duration: 0.8, ease: 'expo.out', stagger: 0.15 }, 0.5)
    const vals = [0.1, 0.3, 275]
    gsap.utils.toArray<HTMLElement>('.p-stat b').forEach((b, i) => {
      countTo(tl, b, vals[i], (v) => (i === 2 ? `${Math.round(v)}k` : `${v.toFixed(2)}%`), 0.6 + i * 0.15, 1.3)
    })
    tl.from('.p-road li', { x: -24, opacity: 0, duration: 0.5, ease: 'power3.out', stagger: 0.09 }, 1.6)
  })
  return (
    <section className="scene scene--light" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>Business &amp; roadmap</span></div>
        <h2 className="p-h s10-h" style={{ fontSize: 'clamp(34px, 5vw, 80px)' }}>Simple to price. Built to <em>stay</em>.</h2>
        <div className="p-stats">
          <div className="p-stat"><b>0.10%</b><span>protocol fee on the deposit, planned for mainnet. Hard-capped at 0.5% in the contract; 0 on testnet.</span></div>
          <div className="p-stat"><b>0.30%</b><span>Guard bounty paid to keepers in BTC: a permissionless job anyone can run.</span></div>
          <div className="p-stat"><b>275k</b><span>gas for a full coil, paid in BTC. One transaction instead of 25.</span></div>
        </div>
        <div className="p-road">
          <div>
            <h4>Wave 1 · shipped</h4>
            <ul>
              <li>One-transaction coil, unwind and deleverage</li>
              <li>Guard, the signed stop-loss, with a keeper</li>
              <li>Risk cockpit and redemption radar</li>
            </ul>
          </div>
          <div className="later">
            <h4>Wave 2 · next</h4>
            <ul>
              <li>Re-leverage an open trove</li>
              <li>Guard ladders: several triggers</li>
              <li>Coil Risk API over x402, paid in MUSD</li>
              <li>Mezo Passport for Bitcoin wallets</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/* =============================================================== 11 · call to action */

function Cta({ frozen, onExit, mode }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  useScene(root, frozen, (tl) => {
    tl.from('.s11-ring', { drawSVG: '0%', duration: 1.6, ease: 'expo.inOut', stagger: 0.12 }, 0)
      .to('.s11-rings', { rotate: 120, transformOrigin: '50% 50%', duration: 6, ease: 'none' }, 0)
    riseLines(tl, '.s11-h', 0.5)
    tl.from('.p-cta .pbtn', { y: 16, opacity: 0, stagger: 0.1, duration: 0.6 }, 1.4)
  })
  return (
    <section className="scene scene--dark" ref={root}>
      <svg className="s11-rings" viewBox="0 0 400 400" aria-hidden="true" style={{ position: 'absolute', right: '-16vw', top: '50%', width: 'min(64vw, 720px)', transform: 'translateY(-50%)', opacity: 0.55 }}>
        {[180, 152, 126, 102, 80].map((r, i) => (
          <circle key={r} className="s11-ring" cx="200" cy="200" r={r} fill="none" stroke={i === 0 ? '#ededea' : '#f7931a'} strokeWidth={i === 0 ? 10 : 9 - i * 1.4} strokeLinecap="round" strokeDasharray={`${r * 5.1} ${r * 1.2}`} opacity={i === 0 ? 1 : 1 - i * 0.12} />
        ))}
      </svg>
      <div className="scene__in">
        <div className="p-eyebrow"><span>Coil · Mezo testnet</span></div>
        <h2 className="p-h p-h--xl s11-h" style={{ maxWidth: '12ch' }}>Your Bitcoin, <em>wound tight</em>.</h2>
        <div className="p-cta">
          <button className="pbtn pbtn--solid" onClick={() => onExit?.('#/app')}>Open the app</button>
          {mode === 'intro'
            ? <button className="pbtn" onClick={() => onExit?.()}>Enter the site</button>
            : <a className="pbtn" href="https://github.com/Wilivms/Coil" target="_blank" rel="noreferrer">Read the code</a>}
        </div>
      </div>
    </section>
  )
}

export const SCENES: Scene[] = [
  { id: 'asleep', title: 'Bitcoin at rest', theme: 'dark', duration: 7, transition: 'fade', Component: Asleep },
  { id: 'loop', title: 'The problem', theme: 'light', duration: 7.5, transition: 'wipe-up', Component: Loop },
  { id: 'pieces', title: 'The insight', theme: 'dark', duration: 7, transition: 'wipe-left', Component: Primitives },
  { id: 'reveal', title: 'Coil', theme: 'accent', duration: 5.5, transition: 'iris', Component: Reveal },
  { id: 'tx', title: 'How it works', theme: 'dark', duration: 8, transition: 'split', Component: Transaction },
  { id: 'guard', title: 'Guard', theme: 'dark', duration: 8.5, transition: 'diag', Component: Guard },
  { id: 'risk', title: 'Risk cockpit', theme: 'dark', duration: 7.5, transition: 'wipe-up', Component: Risk },
  { id: 'radar', title: 'Redemption radar', theme: 'light', duration: 7.5, transition: 'iris', Component: RadarScene },
  { id: 'proof', title: 'Proof', theme: 'dark', duration: 8, transition: 'wipe-left', Component: Proof },
  { id: 'model', title: 'Business & roadmap', theme: 'light', duration: 7.5, transition: 'split', Component: Model },
  { id: 'cta', title: 'Open the app', theme: 'dark', duration: 7, transition: 'iris', Component: Cta },
]
