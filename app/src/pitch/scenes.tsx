import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import gsap from 'gsap'
import { SplitText } from 'gsap/SplitText'
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'
import { TextPlugin } from 'gsap/TextPlugin'
import { CustomEase } from 'gsap/CustomEase'
import { Draggable } from 'gsap/Draggable'
import type { MarketState, Radar } from '../lib/live'
import { fromWad, planOpen, WAD, type OpenPlan } from '../lib/math'
import { fmtCompact, fmtNum, fmtUsd } from '../lib/format'
import { mulberry32, simulate, touchProbability } from '../lib/risk'
import { reducedMotion } from '../lib/motion'

gsap.registerPlugin(SplitText, ScrambleTextPlugin, DrawSVGPlugin, MotionPathPlugin, TextPlugin, CustomEase, Draggable)
CustomEase.create('coil', 'M0,0 C0.16,0.84 0.24,1.02 1,1')

export type DeckData = { m: MarketState; plan: OpenPlan; radar?: Radar; router: string; live: boolean }
type SceneProps = {
  data: DeckData
  onDone: (reward: number, note?: string) => void
  setHeat: (v: number) => void
  onExit?: (to?: string) => void
  mode?: 'intro' | 'deck'
  sats: number
  done: boolean
}
export type Scene = {
  id: string
  title: string
  theme: 'dark' | 'light' | 'accent'
  hint: string
  Component: ComponentType<SceneProps>
}

const ORANGE = '#f7931a'
const RED = '#ff6a5c'

/** Entrance timeline in a GSAP context (reverted on unmount); reduced motion jumps to the end. */
function useEnter(root: React.RefObject<HTMLElement>, build: (tl: gsap.core.Timeline) => void) {
  useLayoutEffect(() => {
    if (!root.current) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: 0.35 })
      build(tl)
      if (reducedMotion()) tl.progress(1)
    }, root)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function rise(tl: gsap.core.Timeline, target: string | Element, at: gsap.Position = 0) {
  const els = typeof target === 'string' ? gsap.utils.toArray<HTMLElement>(target) : [target as HTMLElement]
  els.forEach((el, i) => {
    const s = SplitText.create(el, { type: 'lines,words', mask: 'lines', linesClass: 'p-split-line' })
    tl.from(s.words, { yPercent: 118, duration: 1.4, ease: 'coil', stagger: 0.045 }, i === 0 ? at : '<0.25')
  })
}

function tweenText(el: Element | null, from: number, to: number, fmt: (v: number) => string, duration = 1.2) {
  if (!el) return
  const o = { v: from }
  return gsap.to(o, { v: to, duration, ease: 'power3.out', onUpdate: () => { el.textContent = fmt(o.v) } })
}

/* ================================================================== 1 · draw a coil */

function Wake({ onDone, done, setHeat }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const ringEl = useRef<SVGCircleElement>(null)
  const st = useRef({
    t: 0, spin: 0, cx: 0, cy: 0, R: 0, px: -999, py: -999,
    drawing: false, path: [] as { x: number; y: number; a: number }[], won: false,
  })
  const [won, setWon] = useState(done)

  useLayoutEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rand = mulberry32(3)
    const N = 760
    const P = Array.from({ length: N }, (_, i) => ({
      x: rand(), y: rand(), vx: (rand() - 0.5) * 0.0005, vy: (rand() - 0.5) * 0.0005,
      a: (i / N) * Math.PI * 2 * 3 + rand() * 0.4, r: 0.35 + (i / N) * 0.65 + (rand() - 0.5) * 0.04,
      hot: rand() < 0.2, s: 0.6 + rand() * 1.6, ox: 0, oy: 0,
    }))
    let raf = 0
    const s = st.current
    const draw = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (el.width !== Math.round(w * dpr)) { el.width = w * dpr; el.height = h * dpr }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!s.R) { s.cx = w > 860 ? w * 0.7 : w * 0.5; s.cy = h * 0.55; s.R = Math.min(w, h) * 0.3 }
      s.spin += 0.002 * (0.3 + s.t)
      for (const p of P) {
        if (s.t < 0.999) {
          p.x += p.vx; p.y += p.vy
          if (p.x < 0 || p.x > 1) p.vx *= -1
          if (p.y < 0 || p.y > 1) p.vy *= -1
        }
        let x = p.x * w, y = p.y * h
        // the cursor stirs the sleeping particles
        const dx = x - s.px, dy = y - s.py, d2 = dx * dx + dy * dy
        if (d2 < 22000) { const f = (1 - d2 / 22000) * 26; p.ox += (dx / Math.sqrt(d2 + 1)) * f * 0.08; p.oy += (dy / Math.sqrt(d2 + 1)) * f * 0.08 }
        p.ox *= 0.92; p.oy *= 0.92
        x += p.ox; y += p.oy
        const ang = p.a + s.spin * (p.hot ? 1.5 : 1)
        const tx = s.cx + Math.cos(ang) * p.r * s.R, ty = s.cy + Math.sin(ang) * p.r * s.R
        x += (tx - x) * s.t; y += (ty - y) * s.t
        ctx.fillStyle = p.hot ? `rgba(247,147,26,${0.5 + 0.5 * s.t})` : `rgba(237,237,234,${0.18 + 0.32 * s.t})`
        ctx.beginPath(); ctx.arc(x, y, p.s * (1 + s.t * 0.3), 0, Math.PI * 2); ctx.fill()
      }
      // the gesture trail
      const tr = s.path.slice(-160)
      if (tr.length > 1) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        for (let i = 1; i < tr.length; i++) {
          ctx.strokeStyle = `rgba(247,147,26,${(i / tr.length) * (s.won ? 0.4 : 0.95)})`
          ctx.lineWidth = 1 + (i / tr.length) * 4
          ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke()
        }
      }
    }
    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    if (done) { s.t = 1; s.won = true }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [done])

  const win = () => {
    const s = st.current
    if (s.won) return
    s.won = true
    setWon(true)
    setHeat(0.6)
    if (s.path.length > 10) {
      const xs = s.path.map((p) => p.x), ys = s.path.map((p) => p.y)
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length
      const r = s.path.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / s.path.length
      gsap.to(s, { cx, cy, R: Math.max(110, Math.min(320, r * 1.15)), duration: 2.4, ease: 'expo.inOut' })
    }
    gsap.to(s, { t: 1, duration: 2.6, ease: 'expo.inOut' })
    const tl = gsap.timeline()
    tl.to('.s1-ask', { opacity: 0, y: -30, filter: 'blur(6px)', duration: 0.7, ease: 'power2.in' })
      .set('.s1-woke', { visibility: 'visible' })
    rise(tl, root.current!.querySelector('.s1-woke-h')!, '>-0.1')
    tl.to('.s1-sleep', { duration: 1.6, scrambleText: { text: 'Coil puts it to work.', chars: '₿01×·', speed: 0.45 } }, '<0.6')
      .from('.s1-sub', { opacity: 0, y: 16, duration: 1 }, '<0.5')
    onDone(100, 'Bitcoin woke up')
  }

  const progress = (v: number) => {
    const c = ringEl.current
    if (c) gsap.to(c, { strokeDashoffset: 2 * Math.PI * 44 * (1 - v), duration: 0.2 })
  }
  const pt = (e: React.PointerEvent) => {
    const r = root.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = (e: React.PointerEvent) => {
    const s = st.current
    if (s.won) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const { x, y } = pt(e)
    s.drawing = true; s.path = [{ x, y, a: 0 }]
    progress(0)
  }
  /** Total turning angle of the stroke around its own centroid (recomputed as it grows). */
  const turned = (path: { x: number; y: number }[]) => {
    let cx = 0, cy = 0
    for (const p of path) { cx += p.x; cy += p.y }
    cx /= path.length; cy /= path.length
    let sum = 0, prev = NaN, spread = 0
    for (const p of path) {
      const a = Math.atan2(p.y - cy, p.x - cx)
      spread = Math.max(spread, Math.hypot(p.x - cx, p.y - cy))
      if (!Number.isNaN(prev)) {
        let d = a - prev
        if (d > Math.PI) d -= 2 * Math.PI
        if (d < -Math.PI) d += 2 * Math.PI
        sum += d
      }
      prev = a
    }
    return spread < 30 ? 0 : Math.abs(sum) // ignore tiny scribbles
  }
  const move = (e: React.PointerEvent) => {
    const s = st.current
    const { x, y } = pt(e)
    s.px = x; s.py = y
    if (!s.drawing || s.won) return
    const last = s.path[s.path.length - 1]
    if (last && Math.hypot(x - last.x, y - last.y) < 3) return
    s.path.push({ x, y, a: 0 })
    if (s.path.length > 400) s.path.shift()
    const p = Math.min(1, turned(s.path) / (Math.PI * 2 * 0.92))
    progress(p)
    if (p >= 1 && s.path.length > 16) win()
  }
  const up = () => { const s = st.current; s.drawing = false; if (!s.won) { progress(0); gsap.delayedCall(0.4, () => { if (!s.drawing && !s.won) s.path = [] }) } }

  /** Accessible fallback: Enter (or the button) draws the coil for you. */
  const auto = () => {
    const s = st.current
    if (s.won) return
    const r = root.current!.getBoundingClientRect()
    const cx = r.width > 860 ? r.width * 0.7 : r.width * 0.5, cy = r.height * 0.55, R = Math.min(r.width, r.height) * 0.22
    s.path = []
    const o = { a: 0 }
    gsap.to(o, {
      a: Math.PI * 2.05, duration: 1.4, ease: 'power2.inOut',
      onUpdate: () => { const x = cx + Math.cos(o.a) * R, y = cy + Math.sin(o.a) * R; s.path.push({ x, y, a: o.a }); progress(o.a / (Math.PI * 2)) },
      onComplete: win,
    })
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter') auto() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  useEnter(root, (tl) => {
    if (done) return
    tl.from('.p-eyebrow', { opacity: 0, x: -20, duration: 1 })
    rise(tl, '.s1-ask-h', 0.2)
    tl.from('.s1-ring', { scale: 0.6, opacity: 0, transformOrigin: '50% 50%', duration: 1.2, ease: 'expo.out' }, 0.9)
      .from('.s1-ask p', { opacity: 0, y: 14, duration: 1 }, 1.2)
  })

  return (
    <section className="scene scene--dark" ref={root}>
      <canvas ref={cv} className="s1-cv" aria-hidden="true" />
      <div className="s1-pad" data-interactive data-cursor={won ? undefined : 'Draw'}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="scene__in" style={{ pointerEvents: 'none' }}>
        <div className="p-eyebrow"><span>Mezo Buildathon</span><span>Track 1 · DeFi</span><span>MUSD × BTC</span></div>
        <div className="s1-stack">
        <div className="s1-ask" style={{ visibility: won ? 'hidden' : 'visible', display: 'grid', gap: 22 }}>
          <h1 className="p-h p-h--xl s1-ask-h">Draw a <em>coil</em>.</h1>
          <p className="p-sub">Your Bitcoin is asleep. Draw one circle anywhere to wake it up.</p>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', pointerEvents: 'auto' }}>
            <svg className="s1-ring" width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
              <circle cx="52" cy="52" r="44" fill="none" stroke="rgba(237,237,234,0.18)" strokeWidth="2" />
              <circle ref={ringEl} cx="52" cy="52" r="44" fill="none" stroke={ORANGE} strokeWidth="3" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 44} strokeDashoffset={2 * Math.PI * 44} transform="rotate(-90 52 52)" />
              <text x="52" y="57" textAnchor="middle" style={{ font: '500 11px var(--f-mono)', letterSpacing: '0.12em', fill: '#ededea' }}>360°</text>
            </svg>
            <button className="pbtn" onClick={auto}>Draw it for me · Enter</button>
          </div>
        </div>
        <div className="s1-woke" style={{ visibility: won ? 'visible' : 'hidden', display: 'grid', gap: 22 }}>
          <h1 className="p-h s1-woke-h">Bitcoin is the best collateral there is.</h1>
          <p className="p-h s1-sleep" style={{ color: ORANGE, fontSize: 'clamp(30px, 4.6vw, 72px)' }}>{won && done ? 'Coil puts it to work.' : ' '}</p>
          <p className="p-sub s1-sub">More than 100 million people hold BTC. Mezo lets them borrow MUSD against it without selling. Coil turns that into leverage in one signature.</p>
        </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 2 · the loop, played */

const STEPS = ['open trove', 'borrow MUSD', 'approve', 'swap → BTC', 'deposit BTC']

function Loop({ onDone, done }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(done ? 25 : 0)
  const [coiled, setCoiled] = useState(done)
  const cells = useRef<(HTMLElement | null)[]>([])
  const spiral = useMemo(() => {
    let d = ''
    for (let i = 0; i <= 700; i++) {
      const a = (i / 700) * Math.PI * 2 * 6, r = 8 + (i / 700) * 150
      d += `${i ? 'L' : 'M'}${(170 + Math.cos(a) * r).toFixed(1)} ${(170 + Math.sin(a) * r).toFixed(1)}`
    }
    return d
  }, [])

  useEnter(root, (tl) => {
    rise(tl, '.s2-h', 0)
    tl.from('.s2-sub', { opacity: 0, y: 14, duration: 1 }, 0.7)
      .from('.p-txgrid i', { scale: 0, opacity: 0, duration: 0.5, ease: 'back.out(2)', stagger: { amount: 0.9, from: 'start' } }, 1.0)
      .from('.s2-btns', { opacity: 0, y: 12, duration: 0.8 }, 1.6)
    if (!done) tl.set('.s2-spiral', { drawSVG: '0%' }, 0)
  })

  const send = () => {
    if (coiled || count >= 25) return
    const n = count + 1
    setCount(n)
    const c = cells.current[n - 1]
    if (c) gsap.fromTo(c, { scale: 0.4 }, { scale: 1, duration: 0.5, ease: 'back.out(3)' })
    gsap.to('.s2-meter i', { scaleX: n / 25, duration: 0.5, ease: 'power2.out' })
    gsap.to('.s2-spiral', { drawSVG: `${(n / 25) * 100}%`, duration: 0.6, ease: 'power2.out' })
    if (n === 4) gsap.fromTo('.s2-coil', { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.7, ease: 'back.out(2)' })
    if (n === 25) collapse(n, 'the hard way')
  }

  const collapse = (from: number, note = '25 → 1') => {
    setCoiled(true)
    const tl = gsap.timeline()
    const rest = cells.current.slice(from)
    tl.to(rest, { backgroundColor: '#111113', scale: 1, duration: 0.15, stagger: 0.03 })
      .to('.s2-meter i', { scaleX: 1, duration: 0.6 }, 0)
      .to('.s2-spiral', { drawSVG: '100%', duration: 0.8 }, 0)
      .to(cells.current.slice(1), { scale: 0, opacity: 0, duration: 0.45, ease: 'back.in(2)', stagger: { amount: 0.5, from: 'end' } }, '+=0.2')
      .to(cells.current[0], { scale: 1.6, duration: 0.6, ease: 'elastic.out(1, 0.5)' }, '>-0.2')
      .to('.s2-spiral', { drawSVG: '0%', duration: 1.1, ease: 'power3.inOut' }, '<')
      .to('.s2-done', { opacity: 1, y: 0, duration: 0.8 }, '>-0.3')
    const n = root.current!.querySelector('.s2-n')
    tl.add(() => { tweenText(n, 25, 1, (v) => String(Math.max(1, Math.round(v))).padStart(2, '0'), 1.4) }, 0.9)
    onDone(250, note)
  }

  const step = count === 0 ? 'nothing yet' : count === 1 ? STEPS[0] : STEPS[1 + ((count - 2) % 4)]
  return (
    <section className="scene scene--light" ref={root}>
      <div className="scene__in">
        <div className="p-row">
          <div style={{ display: 'grid', gap: 22, minWidth: 0 }}>
            <div className="p-eyebrow"><span>The problem</span><span>try it</span></div>
            <h2 className="p-h s2-h">Leverage on Mezo today is a <em>loop</em>.</h2>
            <p className="p-sub s2-sub">Reaching 3× by hand means opening a trove, then borrowing, approving, swapping and depositing. Again and again. Go on, send them yourself.</p>
            <div className="p-txgrid" aria-label={`${count} of 25 transactions sent`}>
              {Array.from({ length: 25 }, (_, i) => (
                <i key={i} ref={(el) => { cells.current[i] = el }} className={(i < count || (coiled && done) ? 'on' : '') + (i === 0 ? ' first' : '')} />
              ))}
            </div>
            <div className="p-meter s2-meter" aria-hidden="true"><i style={{ transform: `scaleX(${done ? 1 : 0})` }} /></div>
            <div style={{ display: 'flex', gap: 18, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="p-big s2-n" style={{ fontSize: 'clamp(54px, 7vw, 110px)' }}>{coiled && done ? '01' : String(count).padStart(2, '0')}</span>
              <span className="p-mono" style={{ fontSize: 14, opacity: 0.7 }}>/ 25 transactions · last: <span style={{ color: 'var(--p-acc-ink)' }}>{coiled ? 'coil()' : step}</span></span>
            </div>
            <div className="s2-btns" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} data-interactive>
              <button className="pbtn pbtn--dark" data-cursor="Click" onClick={send} disabled={coiled}>Send next transaction</button>
              <button className="pbtn pbtn--solid s2-coil" data-cursor="Coil" style={{ opacity: count >= 4 && !coiled ? 1 : 0, pointerEvents: count >= 4 && !coiled ? 'auto' : 'none' }} onClick={() => collapse(count)}>Coil it instead</button>
            </div>
            <p className="p-sub s2-done" style={{ opacity: done ? 1 : 0, transform: done ? 'none' : 'translateY(10px)' }}>One signature, one transaction, one swap. That is Coil.</p>
          </div>
          <svg className="p-svg s2-spiral-wrap" viewBox="0 0 340 340" aria-hidden="true" style={{ maxWidth: 420, justifySelf: 'center' }}>
            <path d={spiral} fill="none" stroke="rgba(17,17,19,0.08)" strokeWidth="2" />
            <path className="s2-spiral" d={spiral} fill="none" stroke="#111113" strokeWidth="2" strokeLinecap="round" />
            <circle cx="170" cy="170" r="6" fill={ORANGE} />
          </svg>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 3 · plug the pieces */

const PIECES = [
  { t: 'Flash swaps', p: 'Mezo Pools send tokens first, call you back, and only check they were paid at the end of the transaction.', c: 'Pool.swap → hook()' },
  { t: 'Signed troves', p: 'MUSD lets a contract open, adjust or close a trove for a borrower who signed. The trove stays theirs.', c: 'openTroveWithSignature' },
  { t: 'Native BTC', p: 'BTC is the gas coin and an ERC-20 over the same balance, so flashed BTC goes straight in as collateral.', c: '0x7b7c…0000' },
]

function Pieces({ onDone, done }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const core = useRef<HTMLDivElement>(null)
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const [plugged, setPlugged] = useState<boolean[]>(done ? [true, true, true] : [false, false, false])
  const [wires, setWires] = useState<string[]>([])
  const pluggedRef = useRef(plugged)
  pluggedRef.current = plugged

  const wireFor = (i: number) => {
    const r = root.current!.getBoundingClientRect()
    const a = cards.current[i]!.getBoundingClientRect()
    const b = core.current!.getBoundingClientRect()
    const x1 = a.left + a.width / 2 - r.left, y1 = a.bottom - r.top
    const x2 = b.left + b.width / 2 - r.left, y2 = b.top + b.height / 2 - r.top
    return `M${x1} ${y1} C${x1} ${y1 + 80} ${x2} ${y2 - 120} ${x2} ${y2}`
  }

  const plug = (i: number) => {
    if (pluggedRef.current[i]) return
    const next = pluggedRef.current.map((v, k) => v || k === i)
    setPlugged(next)
    gsap.to(cards.current[i], { x: 0, y: 0, rotation: 0, duration: 0.8, ease: 'elastic.out(1, 0.6)' })
    setWires((w) => { const c = [...w]; c[i] = wireFor(i); return c })
    gsap.fromTo(core.current, { scale: 1.12 }, { scale: 1, duration: 0.8, ease: 'elastic.out(1, 0.4)' })
    if (next.every(Boolean)) {
      const tl = gsap.timeline({ delay: 0.5 })
      tl.to('.s3-core-label', { duration: 1.2, scrambleText: { text: 'COIL', chars: '01₿×', speed: 0.5 } })
        .to(core.current, { boxShadow: '0 0 0 14px rgba(247,147,26,0.12), 0 0 80px 10px rgba(247,147,26,0.35)', duration: 0.8 }, 0)
        .to('.s3-foot', { opacity: 1, y: 0, duration: 0.8 }, 0.4)
      onDone(300, 'three pieces wired')
    }
  }

  useEffect(() => {
    if (done) { setWires([0, 1, 2].map(wireFor)); return }
    const ds = cards.current.map((el, i) =>
      Draggable.create(el, {
        type: 'x,y', zIndexBoost: true,
        onPress() { gsap.to(el, { rotation: (i - 1) * 4, scale: 1.04, duration: 0.3 }) },
        onRelease() { gsap.to(el, { scale: 1, duration: 0.3 }) },
        onDragEnd() {
          if (this.hitTest(core.current!, '18%')) plug(i)
          else gsap.to(el, { x: 0, y: 0, rotation: 0, duration: 0.9, ease: 'elastic.out(1, 0.5)' })
        },
        onClick() { plug(i) },
      })[0],
    )
    return () => ds.forEach((d) => d.kill())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEnter(root, (tl) => {
    rise(tl, '.s3-h', 0)
    tl.from(cards.current, { rotateY: -70, rotateX: 18, z: -240, opacity: 0, transformOrigin: '0% 50%', duration: 1.5, ease: 'expo.out', stagger: 0.2 }, 0.6)
      .from('.p-card .draw', { drawSVG: '0%', duration: 1.4, ease: 'power2.inOut', stagger: 0.08 }, 1.2)
      .from(core.current, { scale: 0, duration: 1, ease: 'back.out(2)' }, 1.4)
  })

  useLayoutEffect(() => {
    gsap.utils.toArray<SVGPathElement>('.s3-wire.fresh').forEach((p) => {
      p.classList.remove('fresh')
      gsap.fromTo(p, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.9, ease: 'power2.inOut' })
    })
  }, [wires])

  return (
    <section className="scene scene--dark scene--dots" ref={root}>
      <svg className="s3-wires" aria-hidden="true">
        {wires.map((d, i) => d && <path key={i} className="s3-wire fresh" d={d} fill="none" stroke={ORANGE} strokeWidth="2" strokeDasharray="1 0" />)}
      </svg>
      <div className="scene__in">
        <div className="p-eyebrow"><span>The insight</span><span>drag each piece into the core</span></div>
        <h2 className="p-h s3-h">Mezo already ships the <em>three pieces</em>.</h2>
        <div className="p-cards" data-interactive>
          {PIECES.map((c, i) => (
            <div key={c.t} ref={(el) => { cards.current[i] = el }} className={'p-card' + (plugged[i] ? ' is-plugged' : '')} data-cursor={plugged[i] ? undefined : 'Drag'}>
              <Icon i={i} />
              <h3>{c.t} {plugged[i] && <span className="p-check">✓</span>}</h3>
              <p>{c.p}</p>
              <code>{c.c}</code>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 14 }}>
          <div className={'s3-core' + (plugged.every(Boolean) ? ' is-live' : '')} ref={core}>
            <span className="s3-core-label p-mono">{done ? 'COIL' : `${plugged.filter(Boolean).length}/3`}</span>
          </div>
          <p className="p-sub s3-foot" style={{ opacity: done ? 1 : 0, transform: done ? 'none' : 'translateY(10px)', textAlign: 'center' }}>Wire them together and leverage stops being a loop.</p>
        </div>
      </div>
    </section>
  )
}

function Icon({ i }: { i: number }) {
  if (i === 0) return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path className="draw" d="M10 24 H46 L38 16" stroke={ORANGE} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path className="draw" d="M54 40 H18 L26 48" stroke="#ededea" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  if (i === 1) return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path className="draw" d="M8 46 C 16 30, 22 52, 30 38 S 44 26, 52 40" stroke={ORANGE} strokeWidth="3" strokeLinecap="round" />
      <path className="draw" d="M10 54 H54" stroke="#ededea" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle className="draw" cx="32" cy="32" r="22" stroke={ORANGE} strokeWidth="3" />
      <path className="draw" d="M26 20 V44 M26 22 H36 a5 5 0 0 1 0 10 H26 M26 32 H38 a6 6 0 0 1 0 12 H26" stroke="#ededea" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}

/* ================================================================== 4 · hold to uncoil */

function Hold({ onDone, done }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const ring = useRef<SVGCircleElement>(null)
  const st = useRef({ c: done ? 1 : 0, locked: done, tw: null as gsap.core.Tween | null })
  const [locked, setLocked] = useState(done)
  const C = 2 * Math.PI * 30

  const apply = () => {
    const c = st.current.c
    root.current?.querySelectorAll<HTMLElement>('.s4-word span').forEach((s, i) => {
      s.style.setProperty('--cw', String(62 + 63 * c))
      s.style.transform = `translateY(${(1 - c) * (i % 2 ? 6 : -6)}px)`
    })
    if (ring.current) ring.current.style.strokeDashoffset = String(C * (1 - c))
    const pct = root.current?.querySelector('.s4-pct')
    if (pct) pct.textContent = `${Math.round(c * 100)}%`
  }
  const lock = () => {
    st.current.locked = true
    setLocked(true)
    const tl = gsap.timeline()
    tl.to(root.current, { backgroundColor: '#f4f4f1', color: '#111113', duration: 1.2, ease: 'power2.inOut' })
      .to('.s4-holdui', { opacity: 0, y: 20, duration: 0.5 }, 0)
      .set('.s4-after', { visibility: 'visible' })
    rise(tl, root.current!.querySelector('.s4-tag')!, 0.6)
    tl.from('.s4-meta span', { opacity: 0, y: 10, stagger: 0.15, duration: 0.8 }, 1.3)
    onDone(150, 'uncoiled')
  }
  const press = () => {
    const s = st.current
    if (s.locked) return
    s.tw?.kill()
    s.tw = gsap.to(s, { c: 1, duration: 1.9 * (1 - s.c), ease: 'none', onUpdate: apply, onComplete: lock })
  }
  const release = () => {
    const s = st.current
    if (s.locked) return
    s.tw?.kill()
    s.tw = gsap.to(s, { c: 0, duration: 1.1, ease: 'elastic.out(1, 0.45)', onUpdate: apply })
  }
  useEffect(() => {
    apply()
    const kd = (e: KeyboardEvent) => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); press() } }
    const ku = (e: KeyboardEvent) => { if (e.key === ' ') release() }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); st.current.tw?.kill() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEnter(root, (tl) => {
    if (done) return
    tl.from('.s4-word span', { yPercent: 110, duration: 1.2, ease: 'expo.out', stagger: 0.08 }, 0)
      .from('.s4-holdui', { opacity: 0, y: 20, duration: 0.9 }, 0.8)
  })

  return (
    <section className={'scene ' + (done ? 'scene--light' : 'scene--accent')} ref={root} data-cursor={locked ? undefined : 'Hold'}
      onPointerDown={press} onPointerUp={release} onPointerLeave={release} onPointerCancel={release} style={{ alignContent: 'center', userSelect: 'none' }}>
      <div className="scene__in" style={{ justifyItems: 'start' }}>
        <div className="word s4-word" style={{ fontSize: 'clamp(110px, 24vw, 380px)' }} aria-label="Coil">
          <span>C</span><span>O</span><span>I</span><span>L</span><span style={{ color: locked ? ORANGE : '#141414' }}>.</span>
        </div>
        <div className="s4-holdui" style={{ display: locked ? 'none' : 'flex', gap: 16, alignItems: 'center' }}>
          <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
            <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(20,20,20,0.2)" strokeWidth="3" />
            <circle ref={ring} cx="36" cy="36" r="30" fill="none" stroke="#141414" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C} transform="rotate(-90 36 36)" />
          </svg>
          <div>
            <div className="p-mono" style={{ fontSize: 13, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Press and hold to uncoil · or hold Space</div>
            <div className="p-mono s4-pct" style={{ fontSize: 28 }}>0%</div>
          </div>
        </div>
        <div className="s4-after" style={{ visibility: locked ? 'visible' : 'hidden', display: 'grid', gap: 18 }}>
          <h2 className="p-h s4-tag" style={{ fontWeight: 520, maxWidth: '22ch', fontVariationSettings: "'wdth' 88" }}>Leveraged Bitcoin in one signature.</h2>
          <div className="p-eyebrow s4-meta" style={{ opacity: 1 }}><span>1 signature</span><span>1 transaction</span><span>the trove stays yours</span></div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 5 · the transaction, signed by you */

function Transaction({ data, onDone, done }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const [lev, setLev] = useState(3)
  const [signed, setSigned] = useState(done)
  const p = useMemo(() => planOpen(data.m, WAD, lev), [data.m, lev])
  const W = 240, H = 150, Y = 40
  const xs = [30, 330, 630, 930]
  const nodes = [
    { tag: 'INPUT', title: 'Your BTC', v: `${fromWad(p.deposit).toFixed(2)} BTC` },
    { tag: 'FLASH SWAP', title: 'Pool lends BTC', v: `+${fromWad(p.flashBtc).toFixed(3)} BTC` },
    { tag: 'YOUR TROVE', title: 'Opened in your name', v: `${fromWad(p.totalColl).toFixed(3)} BTC` },
    { tag: 'SETTLE', title: 'Pool repaid in MUSD', v: `${fmtCompact(fromWad(p.musdIn))} MUSD` },
  ]
  const wires = xs.slice(0, -1).map((x, i) => { const a = x + W, b = xs[i + 1], y = Y + H / 2; return `M${a} ${y} C${a + 30} ${y} ${b - 30} ${y} ${b} ${y}` })
  const track = `M${xs[0] + W / 2} ${Y + H / 2} L${xs[3] + W / 2} ${Y + H / 2}`
  const pct = ((lev - 1.5) / 3.5) * 100

  useEnter(root, (tl) => {
    rise(tl, '.s5-h', 0)
    tl.from('.s5-node', { scale: 0.7, opacity: 0, transformOrigin: '50% 50%', duration: 0.9, ease: 'back.out(2)', stagger: 0.25 }, 0.6)
      .from('.s5-ctrl', { opacity: 0, y: 16, duration: 0.9 }, 1.4)
    if (!done) tl.set('.s5-wire', { drawSVG: '0%' }, 0)
  })

  const sign = () => {
    if (signed) return
    setSigned(true)
    const tl = gsap.timeline()
    gsap.utils.toArray<SVGPathElement>('.s5-wire').forEach((w, i) => tl.to(w, { drawSVG: '100%', duration: 0.55, ease: 'power2.inOut' }, 0.3 + i * 0.6))
    gsap.utils.toArray<SVGRectElement>('.s5-node rect').forEach((r, i) => tl.to(r, { stroke: ORANGE, duration: 0.3, yoyo: true, repeat: 1 }, i * 0.6))
    tl.to('.s5-pulse', { opacity: 1, duration: 0.2 }, 0)
      .to('.s5-pulse', { motionPath: { path: '.s5-track', align: '.s5-track', alignOrigin: [0.5, 0.5] }, duration: 2.4, ease: 'power1.inOut' }, 0)
      .to('.s5-pulse', { opacity: 0, duration: 0.3 }, '>')
      .add(() => { tweenText(root.current!.querySelector('.s5-big'), 25, 1, (v) => String(Math.max(1, Math.round(v))), 1.8) }, 0.4)
      .to('.s5-cap', { opacity: 1, y: 0, duration: 0.8 }, 2.2)
    onDone(200, 'signed in one go')
  }

  return (
    <section className="scene scene--dark scene--dots" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>How it works</span><span>live Mezo testnet quote for 1 BTC</span></div>
        <h2 className="p-h s5-h">Four moves. <em>One transaction.</em></h2>
        <svg className="p-svg" viewBox="0 0 1200 230" aria-label={`Coil transaction at ${lev.toFixed(1)}x`}>
          <path className="s5-track" d={track} fill="none" stroke="none" />
          {wires.map((d, i) => (
            <g key={i}>
              <path d={d} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
              <path className="s5-wire" d={d} fill="none" stroke={ORANGE} strokeWidth="2" />
            </g>
          ))}
          {nodes.map((n, i) => (
            <g key={i} className="s5-node">
              <rect x={xs[i]} y={Y} width={W} height={H} rx="10" fill="#17171a" stroke="#2a2a2f" strokeWidth="1.5" />
              <text x={xs[i] + 18} y={Y + 30} style={{ font: '500 11px var(--f-mono)', letterSpacing: '0.12em', fill: '#8f8f98' }}>{n.tag}</text>
              <text x={xs[i] + 18} y={Y + 62} style={{ font: '650 19px var(--f-display)', fill: '#ededea' }}>{n.title}</text>
              <text x={xs[i] + 18} y={Y + 112} style={{ font: '500 26px var(--f-mono)', letterSpacing: '-0.02em', fill: i === 3 ? ORANGE : '#ededea' }}>{n.v}</text>
              <circle cx={xs[i]} cy={Y + H / 2} r="5" fill="#0c0c0e" stroke={ORANGE} strokeWidth="2" />
              <circle cx={xs[i] + W} cy={Y + H / 2} r="5" fill="#0c0c0e" stroke={ORANGE} strokeWidth="2" />
            </g>
          ))}
          <circle className="s5-pulse" r="9" fill={ORANGE} opacity="0" style={{ filter: `drop-shadow(0 0 12px ${ORANGE})` }} />
        </svg>
        <div className="s5-ctrl" data-interactive style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 24, alignItems: 'center' }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <label className="p-eyebrow" htmlFor="p-lev">Leverage</label>
              <span className="p-mono" style={{ fontSize: 13, opacity: 0.7 }}>ratio {(p.icr * 100).toFixed(0)}% · liquidation {fmtUsd(p.liqPrice)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              <span className="p-big" style={{ fontSize: 'clamp(40px, 5vw, 72px)', minWidth: '3.6ch' }}>{lev.toFixed(1)}×</span>
              <input id="p-lev" className="p-range" type="range" min={1.5} max={5} step={0.1} value={lev} data-cursor="Drag"
                style={{ ['--p' as string]: `${pct}%` }} onChange={(e) => setLev(Number(e.target.value))} />
            </div>
          </div>
          <button className={'pbtn ' + (signed ? '' : 'pbtn--solid')} data-cursor="Sign" onClick={sign} style={{ fontSize: 13, padding: '18px 24px' }}>{signed ? 'Signed ✓' : 'Sign & send'}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 22, flexWrap: 'wrap' }}>
          <span className="p-big s5-big" style={{ color: ORANGE, fontSize: 'clamp(54px, 8vw, 130px)' }}>{signed ? '1' : '25'}</span>
          <span className="p-sub s5-cap" style={{ opacity: done ? 1 : signed ? 0.85 : 0.5 }}>{signed ? 'transaction instead of 25. One swap, priced by the pool’s own curve. If any step fails, nothing happens.' : 'transactions to do this by hand. Set your leverage, then sign.'}</span>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 6 · guard, the game */

const CRASH = [1, 0.975, 0.985, 0.95, 0.935, 0.945, 0.905, 0.88, 0.89, 0.85, 0.83, 0.8, 0.775, 0.76, 0.745, 0.71, 0.72, 0.69, 0.7]

function GuardGame({ data, onDone }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const handle = useRef<SVGGElement>(null)
  const s0 = fromWad(data.m.price)
  const C = fromWad(data.plan.totalColl) || 3
  const D = fromWad(data.plan.compositeDebt) || (2 * s0 * 1.006)
  const liq = (1.1 * D) / C
  const Wd = 660, Hd = 380, pl = 10, pr = 10, pt = 24, pb = 24
  const lo = s0 * 0.64, hi = s0 * 1.04
  const X = (i: number) => pl + (i / (CRASH.length - 1)) * (Wd - pl - pr)
  const Y = (v: number) => pt + (1 - (v - lo) / (hi - lo)) * (Hd - pt - pb)
  const Yinv = (y: number) => lo + (1 - (y - pt) / (Hd - pt - pb)) * (hi - lo)
  const d = CRASH.map((f, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(s0 * f).toFixed(1)}`).join('')
  const [guardOn, setGuardOn] = useState(true)
  const [trigger, setTrigger] = useState(liq + (s0 - liq) * 0.5)
  const [result, setResult] = useState<null | { kind: 'saved' | 'deep' | 'liquidated'; text: string; newLiq?: number }>(null)
  const running = useRef(false)

  // Guard sizing, same maths as the app: land on 160% at the trigger.
  const guardOutcome = (T: number) => {
    const k = 1.0331, target = 1.6
    const R = Math.max(0, Math.min(D - 2000, (target * D - C * T) / (target - k)))
    const Wb = (R / T) * k
    const newLiq = (1.1 * (D - R)) / (C - Wb)
    return { R, Wb, newLiq, crAt: (C * T) / D }
  }

  useEffect(() => {
    const g = handle.current
    if (!g) return
    const y0 = Y(trigger)
    const [dr] = Draggable.create(g, {
      type: 'y', bounds: { minY: Y(s0 * 0.985) - y0, maxY: Y(liq * 1.02) - y0 },
      onDrag() { setTrigger(Yinv(y0 + this.y)) },
    })
    return () => { dr.kill() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEnter(root, (tl) => {
    rise(tl, '.s6-h', 0)
    tl.from('.s6-sub', { opacity: 0, y: 12, duration: 0.9 }, 0.6)
      .from('.s6-line', { scaleX: 0, transformOrigin: '0% 50%', duration: 1, ease: 'expo.out', stagger: 0.18 }, 0.8)
      .from('.s6-ui', { opacity: 0, y: 14, duration: 0.8 }, 1.2)
      .set('.s6-price', { drawSVG: '0%' }, 0)
  })

  const crash = () => {
    if (running.current) return
    running.current = true
    setResult(null)
    const firstBelow = (lvl: number) => { for (let i = 1; i < CRASH.length; i++) if (s0 * CRASH[i] <= lvl) return (i - 0.5) / (CRASH.length - 1); return 1 }
    const dur = 4.2
    const g = guardOutcome(trigger)
    const minPrice = s0 * Math.min(...CRASH)
    const tl = gsap.timeline({ onComplete: () => { running.current = false } })
    tl.set('.s6-dot', { opacity: 1 })
      .fromTo('.s6-price', { drawSVG: '0%' }, { drawSVG: '100%', duration: dur, ease: 'none' }, 0)
      .to('.s6-dot', { motionPath: { path: '.s6-price', align: '.s6-price', alignOrigin: [0.5, 0.5] }, duration: dur, ease: 'none' }, 0)
    if (guardOn && trigger > liq) {
      const at = dur * firstBelow(trigger)
      tl.fromTo('.s6-ring', { attr: { cx: X(firstBelow(trigger) * (CRASH.length - 1)), cy: Y(trigger) }, scale: 0, opacity: 1, transformOrigin: '50% 50%' }, { scale: 5, opacity: 0, duration: 1.1, ease: 'expo.out' }, at)
        .to('.s6-liq', { attr: { y1: Y(g.newLiq), y2: Y(g.newLiq) }, duration: 1.2, ease: 'power3.inOut' }, at + 0.1)
        .add(() => { tweenText(root.current!.querySelector('.s6-cr'), g.crAt * 100, 160, (v) => `${Math.round(v)}%`, 1.2) }, at)
      const saved = g.newLiq < minPrice
      tl.add(() => {
        setResult(saved
          ? { kind: 'saved', text: `Guard fired at ${fmtUsd(trigger)}, repaid ${fmtCompact(g.R)} MUSD and moved liquidation down to ${fmtUsd(g.newLiq)}. The crash bottomed at ${fmtUsd(minPrice)}: you kept the position.`, newLiq: g.newLiq }
          : { kind: 'deep', text: `Guard fired, but the crash went deeper than the new liquidation price (${fmtUsd(g.newLiq)}). Set the trigger higher and crash again.`, newLiq: g.newLiq })
        if (saved) onDone(400, 'saved by Guard')
      }, dur)
    } else {
      const at = dur * firstBelow(liq)
      tl.to('.s6-flash', { opacity: 0.55, duration: 0.12, yoyo: true, repeat: 3 }, at)
        .add(() => { tweenText(root.current!.querySelector('.s6-cr'), 120, 0, (v) => `${Math.round(v)}%`, 0.8) }, at)
        .add(() => setResult({ kind: 'liquidated', text: `No Guard: at ${fmtUsd(liq)} the trove fell under 110% and was liquidated. Turn Guard on and crash again.` }), dur)
    }
  }
  const reset = () => {
    gsap.set('.s6-price', { drawSVG: '0%' }); gsap.set('.s6-dot', { opacity: 0 })
    gsap.set('.s6-liq', { attr: { y1: Y(liq), y2: Y(liq) } })
    const cr = root.current!.querySelector('.s6-cr'); if (cr) cr.textContent = `${Math.round(((C * s0) / D) * 100)}%`
    setResult(null)
  }
  const crNow = (C * s0) / D
  const g = guardOutcome(trigger)

  return (
    <section className="scene scene--dark" ref={root}>
      <div className="s6-flash" aria-hidden="true" />
      <div className="scene__in">
        <div className="p-row">
          <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
            <div className="p-eyebrow"><span>Guard</span><span>signed stop-loss · play it</span></div>
            <h2 className="p-h s6-h">A trove that defends <em>itself</em>.</h2>
            <p className="p-sub s6-sub">Drag the orange line to set your trigger, then crash BTC. Guard flash-borrows MUSD, repays part of the debt and sells only the BTC it needs. Any keeper can run it, for 0.3%.</p>
            <div className="s6-ui" data-interactive style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="pbtn pbtn--solid" data-cursor="Crash" onClick={crash}>Crash BTC ↓</button>
              <button className={'pbtn' + (guardOn ? ' is-on' : '')} data-cursor="Toggle" onClick={() => { setGuardOn((v) => !v); reset() }}>Guard {guardOn ? 'on' : 'off'}</button>
              <button className="pbtn" onClick={reset}>Reset</button>
            </div>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div><div className="p-eyebrow">your ratio</div><div className="p-big s6-cr" style={{ fontSize: 'clamp(44px, 5.5vw, 88px)', color: ORANGE }}>{Math.round(crNow * 100)}%</div></div>
              <div className="p-mono" style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6 }}>
                trigger {fmtUsd(trigger)} · ratio there {Math.round(g.crAt * 100)}%<br />
                repay {fmtCompact(g.R)} MUSD → liquidation {fmtUsd(g.newLiq)}
              </div>
            </div>
            <p className={'p-result p-result--' + (result?.kind ?? 'idle')} aria-live="polite">{result?.text ?? 'Waiting for a crash.'}</p>
          </div>
          <svg className="p-svg" viewBox={`0 0 ${Wd} ${Hd}`} data-interactive aria-label="Price chart with a draggable Guard trigger">
            <line className="s6-line" x1={pl} x2={Wd - pr} y1={Y(s0)} y2={Y(s0)} stroke="rgba(237,237,234,0.35)" />
            <line className="s6-line s6-liq" x1={pl} x2={Wd - pr} y1={Y(liq)} y2={Y(liq)} stroke={RED} strokeDasharray="3 4" strokeWidth="1.5" />
            <text x={Wd - pr} y={Y(s0) - 8} textAnchor="end" style={{ font: '11px var(--f-mono)', fill: '#8f8f98' }}>today {fmtUsd(s0)}</text>
            <text x={Wd - pr} y={Y(liq) + 18} textAnchor="end" style={{ font: '11px var(--f-mono)', fill: RED }}>liquidation {fmtUsd(liq)}</text>
            <path className="s6-price" d={d} fill="none" stroke="#ededea" strokeWidth="2.5" strokeLinejoin="round" />
            <circle className="s6-ring" cx="0" cy="0" r="10" fill="none" stroke={ORANGE} strokeWidth="2" opacity="0" />
            <circle className="s6-dot" r="6" fill={ORANGE} opacity="0" />
            <g ref={handle} style={{ opacity: guardOn ? 1 : 0.25 }} data-cursor="Drag">
              <rect x={pl} y={Y(liq + (s0 - liq) * 0.5) - 14} width={Wd - pl - pr} height="28" fill="transparent" />
              <line className="s6-line" x1={pl} x2={Wd - pr} y1={Y(liq + (s0 - liq) * 0.5)} y2={Y(liq + (s0 - liq) * 0.5)} stroke={ORANGE} strokeDasharray="7 5" strokeWidth="2" />
              <rect x={Wd - pr - 150} y={Y(liq + (s0 - liq) * 0.5) - 13} width="150" height="26" rx="13" fill={ORANGE} />
              <text x={Wd - pr - 75} y={Y(liq + (s0 - liq) * 0.5) + 4} textAnchor="middle" style={{ font: '600 11px var(--f-mono)', fill: '#141414', letterSpacing: '0.06em' }}>GUARD ↕ {fmtCompact(trigger)}</text>
            </g>
          </svg>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 7 · Monte Carlo sandbox */

function RiskField({ data, onDone, setHeat }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const s0 = fromWad(data.m.price)
  const [sigma, setSigma] = useState(0.5)
  const [lev, setLev] = useState(3)
  const reveal = useRef({ v: 0 })
  const liq = useMemo(() => planOpen(data.m, WAD, lev).liqPrice || s0 * 0.73, [data.m, lev, s0])
  const sim = useMemo(() => simulate(s0, sigma, 30, 220, liq, 21), [s0, sigma, liq])
  const mc = sim.breached.reduce((a, b) => a + b, 0) / sim.breached.length
  const p30 = touchProbability(s0, liq, sigma, 30 / 365)
  const touched = useRef(false)

  useEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let raf = 0
    const lo = s0 * 0.45, hi = s0 * 1.7
    const draw = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (el.width !== Math.round(w * dpr)) { el.width = w * dpr; el.height = h * dpr }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const X = (dd: number) => (dd / 30) * w
      const Yy = (v: number) => (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * h
      const k = reveal.current.v
      const n = Math.floor(k * sim.paths.length)
      for (let i = 0; i < n; i++) {
        const p = sim.paths[i], bd = sim.breachDay[i]
        ctx.lineWidth = 1
        ctx.strokeStyle = bd >= 0 ? 'rgba(255,106,92,0.5)' : 'rgba(237,237,234,0.14)'
        ctx.beginPath()
        for (let dd = 0; dd <= 30; dd++) (dd ? ctx.lineTo : ctx.moveTo).call(ctx, X(dd), Yy(p[dd]))
        ctx.stroke()
      }
      ctx.setLineDash([3, 4]); ctx.strokeStyle = RED; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(0, Yy(liq)); ctx.lineTo(w, Yy(liq)); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = RED; ctx.font = '11px "Martian Mono Variable", monospace'
      ctx.fillText('liquidation ' + fmtUsd(liq), 8, Yy(liq) - 8)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [sim, s0, liq])

  useEffect(() => { gsap.fromTo(reveal.current, { v: Math.min(reveal.current.v, 0.4) }, { v: 1, duration: 1.2, ease: 'power2.out' }) }, [sim])

  const scrub = (e: React.PointerEvent) => {
    if (e.buttons !== 1 && e.pointerType === 'mouse') return
    const r = cv.current!.getBoundingClientRect()
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    setSigma(Math.round((0.2 + fx * 1.0) * 100) / 100)
    setLev(Math.round((6 - fy * 4.5) * 10) / 10)
    setHeat(fx)
    if (!touched.current) { touched.current = true; onDone(150, 'stress-tested') }
  }

  useEnter(root, (tl) => {
    rise(tl, '.s7-h', 0)
    tl.from('.s7-read', { opacity: 0, y: 14, stagger: 0.12, duration: 0.8 }, 0.6)
      .to('.s7-f', { duration: 2.8, text: { value: 'P(τ ≤ T) = Φ((ln L/S − νT) / σ√T) + (L/S)^(2ν/σ²) · Φ((ln L/S + νT) / σ√T)' }, ease: 'none' }, 1.2)
  })

  return (
    <section className="scene scene--dark" ref={root}>
      <div className="scene__in">
        <div className="p-row" style={{ ['--cols' as string]: '1fr 1.25fr' }}>
          <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
            <div className="p-eyebrow"><span>Risk cockpit</span><span>drag on the field</span></div>
            <h2 className="p-h s7-h">Odds, <em>not vibes</em>.</h2>
            <div className="s7-read" style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
              <div><div className="p-eyebrow">volatility →</div><div className="p-big" style={{ fontSize: 'clamp(36px, 4.4vw, 68px)' }}>{Math.round(sigma * 100)}%</div></div>
              <div><div className="p-eyebrow">leverage ↑</div><div className="p-big" style={{ fontSize: 'clamp(36px, 4.4vw, 68px)' }}>{lev.toFixed(1)}×</div></div>
            </div>
            <div className="s7-read" style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
              <div><div className="p-eyebrow">30-day odds · model</div><div className="p-big" style={{ fontSize: 'clamp(36px, 4.4vw, 68px)' }}>{(p30 * 100).toFixed(1)}%</div></div>
              <div><div className="p-eyebrow">Monte Carlo · 220 paths</div><div className="p-big" style={{ fontSize: 'clamp(36px, 4.4vw, 68px)', color: RED }}>{(mc * 100).toFixed(1)}%</div></div>
            </div>
            <div className="p-formula s7-f" aria-label="First-passage probability formula" />
          </div>
          <div className="s7-field" data-interactive data-cursor="Drag" onPointerDown={scrub} onPointerMove={scrub}>
            <canvas ref={cv} className="p-canvas" aria-label={`Monte Carlo paths, ${Math.round(mc * 100)} percent reach liquidation`} />
            <span className="s7-axis s7-axis--x p-mono">volatility →</span>
            <span className="s7-axis s7-axis--y p-mono">leverage ↑</span>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 8 · radar, scrubbed */

function RadarScrub({ data, onDone }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const bars = useRef<HTMLDivElement>(null)
  const troves = useMemo(() => {
    if (data.radar?.troves.length) return data.radar.troves.filter((t) => Number.isFinite(t.cr)).map((t) => ({ cr: t.cr, debt: t.debt }))
    const r = mulberry32(5)
    return Array.from({ length: data.m.troves || 247 }, () => ({ cr: 1.12 + Math.pow(r(), 1.6) * 4, debt: 2000 + Math.pow(r(), 3) * 400_000 })).sort((a, b) => a.cr - b.cr)
  }, [data.radar, data.m.troves])
  const maxLog = Math.max(...troves.map((t) => Math.log10(t.debt)))
  const [pos, setPos] = useState(0.4)
  const touched = useRef(false)
  const i = Math.min(troves.length - 1, Math.floor(pos * troves.length))
  const cr = troves[i]?.cr ?? 1.5
  const lev = cr > 1.0001 ? 1 / (1 - 1 / (cr * 1.006)) : 10
  let ahead = 0
  for (let k = 0; k < i; k++) if (troves[k].cr >= 1.1) ahead += Math.max(0, troves[k].debt - 200)

  const scrub = (e: React.PointerEvent) => {
    if (e.buttons !== 1 && e.pointerType === 'mouse') return
    const r = bars.current!.getBoundingClientRect()
    setPos(Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width)))
    if (!touched.current) { touched.current = true; onDone(150, 'found your place') }
  }
  useEnter(root, (tl) => {
    rise(tl, '.s8-h', 0)
    tl.from('.p-radar i', { scaleY: 0, duration: 0.8, ease: 'power3.out', stagger: { amount: 1.4 } }, 0.5)
      .from('.p-radar .you', { opacity: 0, duration: 0.5 }, 1.6)
  })
  return (
    <section className="scene scene--light" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>Redemption radar</span><span>{data.radar ? `${troves.length} live troves on Mezo testnet` : 'troves on Mezo testnet'}</span><span>drag along the queue</span></div>
        <h2 className="p-h s8-h">Know your place in the <em>redemption queue</em>.</h2>
        <div className="p-radar" ref={bars} data-interactive data-cursor="Drag" onPointerDown={scrub} onPointerMove={scrub}>
          {troves.map((t, k) => <i key={k} className={k < i ? 'ahead' : ''} style={{ height: `${12 + (88 * Math.log10(t.debt)) / maxLog}%` }} />)}
          <span className="you" style={{ left: `${(i / troves.length) * 100}%` }} />
        </div>
        <div style={{ display: 'flex', gap: 36, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div><div className="p-eyebrow">your ratio</div><div className="p-big" style={{ fontSize: 'clamp(40px, 5vw, 80px)' }}>{Math.round(cr * 100)}%</div></div>
          <div><div className="p-eyebrow">≈ leverage</div><div className="p-big" style={{ fontSize: 'clamp(40px, 5vw, 80px)' }}>{Math.min(lev, 12).toFixed(1)}×</div></div>
          <div><div className="p-eyebrow">MUSD redeemed before you</div><div className="p-big" style={{ fontSize: 'clamp(40px, 5vw, 80px)', color: 'var(--p-acc-ink)' }}>{fmtCompact(ahead)}</div></div>
          <p className="p-sub" style={{ maxWidth: '36ch' }}>MUSD redeems the lowest ratios first. More leverage moves you to the front of the line.</p>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 9 · run the proof */

function Terminal({ data, onDone }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const steps = useMemo(() => [
    { cmd: 'forge test --fork-url mezo_testnet', out: [['ok', '[PASS] test_fork_coilThenUnwind()   real MUSD + real MUSD/BTC pool'], ['ok', '22 passed · 0 failed · fuzzed open → close round trips']] },
    { cmd: 'forge script Deploy.s.sol --broadcast', out: [['acc', `✓ CoilRouter ${data.router}`], ['dim', 'block 16,188,308 · Mezo testnet 31611 · 2.44M gas']] },
    { cmd: 'coil status --live', out: [['', `BTC ${fmtUsd(fromWad(data.m.price))} · pool ${fmtCompact(fromWad(data.m.reserveBtc))} BTC · TCR ${Math.round(data.m.tcr * 100)}% · ${data.m.troves} troves`]] },
  ], [data])
  const [ran, setRan] = useState(0)
  const typed = useRef<HTMLSpanElement>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    if (ran >= steps.length || !typed.current) return
    typed.current.textContent = ''
    const t = gsap.to(typed.current, { text: { value: steps[ran].cmd }, duration: steps[ran].cmd.length * 0.035, ease: 'none', delay: ran === 0 ? 1.2 : 0.2 })
    return () => { t.kill() }
  }, [ran, steps])

  const run = () => {
    if (runningRef.current || ran >= steps.length) return
    runningRef.current = true
    const n = ran + 1
    setRan(n)
    requestAnimationFrame(() => {
      const outs = root.current!.querySelectorAll(`.l[data-step="${n - 1}"]`)
      outs.forEach((el) => {
        const text = el.getAttribute('data-text') ?? ''
        el.textContent = ''
        if (el.classList.contains('acc')) gsap.to(el, { duration: 1.1, scrambleText: { text, chars: '0123456789abcdefABCDEF', speed: 0.7, revealDelay: 0.2 } })
        else gsap.to(el, { duration: Math.min(1, text.length * 0.018), text: { value: text }, ease: 'none' })
      })
      gsap.delayedCall(1.1, () => { runningRef.current = false })
      if (n === steps.length) onDone(200, 'verified on-chain')
    })
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); run() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  useEnter(root, (tl) => {
    rise(tl, '.s9-h', 0)
    tl.from('.p-term', { y: 40, opacity: 0, rotateX: 12, transformPerspective: 900, duration: 1.1, ease: 'expo.out' }, 0.3)
  })
  return (
    <section className="scene scene--dark scene--dots" ref={root}>
      <div className="scene__in">
        <div className="p-row" style={{ ['--cols' as string]: '1fr 1.15fr' }}>
          <div style={{ display: 'grid', gap: 20 }}>
            <div className="p-eyebrow"><span>Proof</span><span>press Enter to run</span></div>
            <h2 className="p-h s9-h" style={{ fontSize: 'clamp(34px, 4.6vw, 72px)' }}>Live on Mezo testnet. Tested against <em>the real thing</em>.</h2>
          </div>
          <div className="p-term" role="log" aria-label="Test and deployment output" data-interactive data-cursor={ran < steps.length ? 'Run' : undefined} onClick={run}>
            {steps.slice(0, ran).map((s, i) => (
              <div key={i}>
                <div className="l dim">$ {s.cmd}</div>
                {s.out.map(([cls, text], j) => <div key={j} className={'l ' + cls} data-step={i} data-text={text}>{text}</div>)}
              </div>
            ))}
            {ran < steps.length ? (
              <div className="l"><span className="dim">$ </span><span ref={typed} /><span className="caret" /> <span className="p-enter">↵ Enter</span></div>
            ) : (
              <div className="l ok">All green. <span className="caret" /></div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 10 · model & roadmap */

function Model({ onDone }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  useEnter(root, (tl) => {
    rise(tl, '.s10-h', 0)
    tl.from('.p-stat', { y: 30, opacity: 0, duration: 1, ease: 'expo.out', stagger: 0.18 }, 0.6)
    const vals = [0.1, 0.3, 275]
    gsap.utils.toArray<HTMLElement>('.p-stat b').forEach((b, i) => {
      tl.add(() => { tweenText(b, 0, vals[i], (v) => (i === 2 ? `${Math.round(v)}k` : `${v.toFixed(2)}%`), 1.6) }, 0.7 + i * 0.18)
    })
    tl.from('.p-road li', { x: -24, opacity: 0, duration: 0.7, ease: 'power3.out', stagger: 0.12 }, 1.6)
      .add(() => onDone(100, 'read the plan'), 2.8)
  })
  const tilt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width - 0.5, fy = (e.clientY - r.top) / r.height - 0.5
    gsap.to(e.currentTarget, { rotateY: fx * 10, rotateX: -fy * 10, transformPerspective: 700, duration: 0.5 })
  }
  const untilt = (e: React.PointerEvent<HTMLDivElement>) => gsap.to(e.currentTarget, { rotateY: 0, rotateX: 0, duration: 0.8, ease: 'elastic.out(1, 0.5)' })
  return (
    <section className="scene scene--light" ref={root}>
      <div className="scene__in">
        <div className="p-eyebrow"><span>Business &amp; roadmap</span></div>
        <h2 className="p-h s10-h" style={{ fontSize: 'clamp(34px, 5vw, 80px)' }}>Simple to price. Built to <em>stay</em>.</h2>
        <div className="p-stats">
          {[
            ['0.10%', 'protocol fee on the deposit, planned for mainnet. Hard-capped at 0.5% in the contract; 0 on testnet.'],
            ['0.30%', 'Guard bounty paid to keepers in BTC: a permissionless job anyone can run.'],
            ['275k', 'gas for a full coil, paid in BTC. One transaction instead of 25.'],
          ].map(([b, t]) => (
            <div className="p-stat" key={b} onPointerMove={tilt} onPointerLeave={untilt} data-cursor="Look"><b>{b}</b><span>{t}</span></div>
          ))}
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

/* ================================================================== 11 · finale */

function Finale({ onExit, mode, sats }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const rings = useRef<SVGSVGElement>(null)
  useEnter(root, (tl) => {
    tl.from('.s11-ring', { drawSVG: '0%', duration: 1.8, ease: 'expo.inOut', stagger: 0.14 }, 0)
    rise(tl, '.s11-h', 0.5)
    tl.add(() => { tweenText(root.current!.querySelector('.s11-sats'), 0, sats, (v) => fmtNum(Math.round(v)), 1.8) }, 1.2)
      .from('.p-cta .pbtn', { y: 16, opacity: 0, stagger: 0.12, duration: 0.8 }, 1.6)
  })
  const par = (e: React.PointerEvent) => {
    const fx = e.clientX / innerWidth - 0.5, fy = e.clientY / innerHeight - 0.5
    gsap.to(rings.current, { x: fx * 60, y: fy * 40, rotate: fx * 30, duration: 1.2, ease: 'power3.out' })
  }
  return (
    <section className="scene scene--dark" ref={root} onPointerMove={par}>
      <svg ref={rings} viewBox="0 0 400 400" aria-hidden="true" className="s11-rings">
        {[180, 152, 126, 102, 80].map((r, i) => (
          <circle key={r} className="s11-ring" cx="200" cy="200" r={r} fill="none" stroke={i === 0 ? '#ededea' : ORANGE} strokeWidth={i === 0 ? 10 : 9 - i * 1.4} strokeLinecap="round" strokeDasharray={`${r * 5.1} ${r * 1.2}`} opacity={i === 0 ? 1 : 1 - i * 0.12} transform={`rotate(${i * 40} 200 200)`} />
        ))}
      </svg>
      <div className="scene__in">
        <div className="p-eyebrow"><span>You earned</span><span><b className="s11-sats" style={{ color: ORANGE, fontWeight: 500 }}>{fmtNum(sats)}</b> sats on this tour</span></div>
        <h2 className="p-h p-h--xl s11-h" style={{ maxWidth: '12ch' }}>Your Bitcoin, <em>wound tight</em>.</h2>
        <div className="p-cta">
          <button className="pbtn pbtn--solid" data-cursor="Open" onClick={() => onExit?.('#/app')}>Open the app</button>
          {mode === 'intro'
            ? <button className="pbtn" onClick={() => onExit?.()}>Enter the site</button>
            : <a className="pbtn" href="https://github.com/Wilivms/Coil" target="_blank" rel="noreferrer">Read the code</a>}
        </div>
      </div>
    </section>
  )
}

export const SCENES: Scene[] = [
  { id: 'wake', title: 'Wake your Bitcoin', theme: 'dark', hint: 'Draw a circle', Component: Wake },
  { id: 'loop', title: 'The problem', theme: 'light', hint: 'Send a few transactions', Component: Loop },
  { id: 'pieces', title: 'The insight', theme: 'dark', hint: 'Drag the pieces in', Component: Pieces },
  { id: 'reveal', title: 'Coil', theme: 'accent', hint: 'Press and hold', Component: Hold },
  { id: 'tx', title: 'How it works', theme: 'dark', hint: 'Set leverage, then sign', Component: Transaction },
  { id: 'guard', title: 'Guard', theme: 'dark', hint: 'Set the trigger, crash BTC', Component: GuardGame },
  { id: 'risk', title: 'Risk cockpit', theme: 'dark', hint: 'Drag on the field', Component: RiskField },
  { id: 'radar', title: 'Redemption radar', theme: 'light', hint: 'Drag along the queue', Component: RadarScrub },
  { id: 'proof', title: 'Proof', theme: 'dark', hint: 'Press Enter to run', Component: Terminal },
  { id: 'model', title: 'Business & roadmap', theme: 'light', hint: 'Scroll when ready', Component: Model },
  { id: 'finale', title: 'Open the app', theme: 'dark', hint: 'Open the app', Component: Finale },
]
