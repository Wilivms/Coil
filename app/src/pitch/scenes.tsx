import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import gsap from 'gsap'
import { SplitText } from 'gsap/SplitText'
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { CustomEase } from 'gsap/CustomEase'
import type { MarketState } from '../lib/live'
import type { OpenPlan } from '../lib/math'
import { mulberry32 } from '../lib/risk'
import { reducedMotion } from '../lib/motion'

gsap.registerPlugin(SplitText, ScrambleTextPlugin, DrawSVGPlugin, CustomEase)
CustomEase.create('coil', 'M0,0 C0.16,0.84 0.24,1.02 1,1')

export type Theme = 'dark' | 'light' | 'accent'
export type DeckData = { m: MarketState; plan: OpenPlan; router: string; live: boolean }
export type SceneProps = {
  data: DeckData
  /** The chapter's moment has happened: the chrome switches to "scroll to continue". */
  onDone: () => void
  /** What a scroll should do first (play the moment for people who skip it). Return true if it consumed the scroll. */
  setIntercept: (fn: (() => boolean) | null) => void
  setTheme: (t: Theme) => void
  setPulse: () => void
  onExit?: (to?: string) => void
  mode?: 'intro' | 'deck'
}
export type Scene = { id: string; title: string; theme: Theme; hint: string; Component: ComponentType<SceneProps> }

const ORANGE = '#f7931a'

function useEnter(root: React.RefObject<HTMLElement>, build: (tl: gsap.core.Timeline) => void) {
  useLayoutEffect(() => {
    if (!root.current) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: 0.3 })
      build(tl)
      if (reducedMotion()) tl.progress(1)
    }, root)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function rise(tl: gsap.core.Timeline, el: Element | string, at: gsap.Position = 0) {
  const s = SplitText.create(el, { type: 'lines,words', mask: 'lines', linesClass: 'p-split-line' })
  tl.from(s.words, { yPercent: 118, duration: 1.3, ease: 'coil', stagger: 0.05 }, at)
}

/** One-shot particle burst on a canvas covering the scene (the "wow" beats). */
function burst(cv: HTMLCanvasElement, x: number, y: number, colors: string[], count = 260, power = 1) {
  if (reducedMotion()) return
  const ctx = cv.getContext('2d')!
  const dpr = Math.min(1.5, window.devicePixelRatio || 1)
  const w = cv.clientWidth, h = cv.clientHeight
  if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr }
  const rand = mulberry32(Math.floor(x * 7 + y * 13))
  const ps = Array.from({ length: count }, () => {
    const a = rand() * Math.PI * 2, v = (2 + rand() * 9) * power
    return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2 * power, r: 1.5 + rand() * 3, c: colors[Math.floor(rand() * colors.length)], life: 0.7 + rand() * 0.9 }
  })
  const t0 = performance.now()
  const step = (now: number) => {
    const t = (now - t0) / 1000
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    let alive = 0
    for (const p of ps) {
      if (t > p.life) continue
      alive++
      p.vx *= 0.965; p.vy = p.vy * 0.965 + 0.18
      p.x += p.vx; p.y += p.vy
      ctx.globalAlpha = 1 - t / p.life
      ctx.fillStyle = p.c
      ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r)
    }
    ctx.globalAlpha = 1
    if (alive) requestAnimationFrame(step)
    else ctx.clearRect(0, 0, w, h)
  }
  requestAnimationFrame(step)
}

/* ================================================================== 1 · draw a coil */

function Wake({ onDone, setIntercept, setPulse }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const ringEl = useRef<SVGCircleElement>(null)
  const st = useRef({ t: 0, spin: 0, cx: 0, cy: 0, R: 0, px: -999, py: -999, drawing: false, path: [] as { x: number; y: number }[], won: false })
  const [won, setWon] = useState(false)

  useLayoutEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(1.5, window.devicePixelRatio || 1)
    const rand = mulberry32(3)
    const N = 560
    const P = Array.from({ length: N }, (_, i) => ({
      x: rand(), y: rand(), vx: (rand() - 0.5) * 0.0005, vy: (rand() - 0.5) * 0.0005,
      a: (i / N) * Math.PI * 6 + rand() * 0.4, r: 0.35 + (i / N) * 0.65 + (rand() - 0.5) * 0.04,
      hot: rand() < 0.2, s: 0.6 + rand() * 1.5, ox: 0, oy: 0,
    }))
    let raf = 0
    const s = st.current
    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (document.hidden) return
      const w = el.clientWidth, h = el.clientHeight
      if (el.width !== Math.round(w * dpr)) { el.width = w * dpr; el.height = h * dpr }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!s.R) { s.cx = w > 860 ? w * 0.7 : w * 0.5; s.cy = h * 0.55; s.R = Math.min(w, h) * 0.3 }
      s.spin += 0.002 * (0.3 + s.t)
      const hot = new Path2D(), cold = new Path2D()
      for (const p of P) {
        if (s.t < 0.999) {
          p.x += p.vx; p.y += p.vy
          if (p.x < 0 || p.x > 1) p.vx *= -1
          if (p.y < 0 || p.y > 1) p.vy *= -1
        }
        let x = p.x * w, y = p.y * h
        const dx = x - s.px, dy = y - s.py, d2 = dx * dx + dy * dy
        if (d2 < 22000) { const f = (1 - d2 / 22000) * 2; const d = Math.sqrt(d2 + 1); p.ox += (dx / d) * f; p.oy += (dy / d) * f }
        p.ox *= 0.92; p.oy *= 0.92
        x += p.ox; y += p.oy
        const ang = p.a + s.spin * (p.hot ? 1.5 : 1)
        x += (s.cx + Math.cos(ang) * p.r * s.R - x) * s.t
        y += (s.cy + Math.sin(ang) * p.r * s.R - y) * s.t
        const r = p.s * (1 + s.t * 0.3)
        const path = p.hot ? hot : cold
        path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2)
      }
      ctx.fillStyle = `rgba(237,237,234,${0.18 + 0.32 * s.t})`; ctx.fill(cold)
      ctx.fillStyle = `rgba(247,147,26,${0.5 + 0.5 * s.t})`; ctx.fill(hot)
      const tr = s.path.slice(-160)
      if (tr.length > 1) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        ctx.strokeStyle = s.won ? `rgba(247,147,26,${0.35 * (1 - s.t)})` : 'rgba(247,147,26,0.9)'
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.moveTo(tr[0].x, tr[0].y)
        for (let i = 1; i < tr.length; i++) ctx.lineTo(tr[i].x, tr[i].y)
        ctx.stroke()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const win = () => {
    const s = st.current
    if (s.won) return
    s.won = true
    setWon(true)
    setPulse()
    if (s.path.length > 10) {
      const cx = s.path.reduce((a, p) => a + p.x, 0) / s.path.length, cy = s.path.reduce((a, p) => a + p.y, 0) / s.path.length
      const r = s.path.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / s.path.length
      gsap.to(s, { cx, cy, R: Math.max(110, Math.min(320, r * 1.15)), duration: 2.4, ease: 'expo.inOut' })
    }
    gsap.to(s, { t: 1, duration: 2.6, ease: 'expo.inOut' })
    const tl = gsap.timeline()
    tl.to('.s1-ask', { opacity: 0, y: -30, duration: 0.6, ease: 'power2.in' })
      .set('.s1-woke', { visibility: 'visible' })
      .add(() => { const t2 = gsap.timeline(); rise(t2, root.current!.querySelector('.s1-woke-h')!, 0) })
      .to('.s1-sleep', { duration: 1.5, scrambleText: { text: 'Most of it just sleeps.', chars: '₿01×·', speed: 0.45 } }, '+=0.7')
      .add(() => onDone(), '+=0.1')
  }

  const progress = (v: number) => { if (ringEl.current) ringEl.current.style.strokeDashoffset = String(2 * Math.PI * 44 * (1 - v)) }
  const pt = (e: React.PointerEvent) => { const r = root.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const turned = (path: { x: number; y: number }[]) => {
    let cx = 0, cy = 0
    for (const p of path) { cx += p.x; cy += p.y }
    cx /= path.length; cy /= path.length
    let sum = 0, prev = NaN, spread = 0
    for (const p of path) {
      const a = Math.atan2(p.y - cy, p.x - cx)
      spread = Math.max(spread, Math.hypot(p.x - cx, p.y - cy))
      if (!Number.isNaN(prev)) { let d = a - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; sum += d }
      prev = a
    }
    return spread < 30 ? 0 : Math.abs(sum)
  }
  const down = (e: React.PointerEvent) => {
    const s = st.current
    if (s.won) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    s.drawing = true; s.path = [pt(e)]; progress(0)
  }
  const move = (e: React.PointerEvent) => {
    const s = st.current
    const { x, y } = pt(e)
    s.px = x; s.py = y
    if (!s.drawing || s.won) return
    const last = s.path[s.path.length - 1]
    if (last && Math.hypot(x - last.x, y - last.y) < 3) return
    s.path.push({ x, y })
    if (s.path.length > 400) s.path.shift()
    const p = Math.min(1, turned(s.path) / (Math.PI * 2 * 0.92))
    progress(p)
    if (p >= 1 && s.path.length > 16) win()
  }
  const up = () => { const s = st.current; s.drawing = false; if (!s.won) { progress(0); gsap.delayedCall(0.4, () => { if (!s.drawing && !s.won) s.path = [] }) } }

  const autoRef = useRef(false)
  const auto = () => {
    const s = st.current
    if (s.won || autoRef.current) return
    autoRef.current = true
    const r = root.current!.getBoundingClientRect()
    const cx = r.width > 860 ? r.width * 0.7 : r.width * 0.5, cy = r.height * 0.55, R = Math.min(r.width, r.height) * 0.22
    s.path = []
    const o = { a: 0 }
    gsap.to(o, { a: Math.PI * 2.05, duration: 1.1, ease: 'power2.inOut', onUpdate: () => { s.path.push({ x: cx + Math.cos(o.a) * R, y: cy + Math.sin(o.a) * R }); progress(o.a / (Math.PI * 2)) }, onComplete: win })
  }
  useEffect(() => {
    setIntercept(() => { if (st.current.won) return false; auto(); return true })
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter') auto() }
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('keydown', k); setIntercept(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEnter(root, (tl) => {
    tl.from('.p-eyebrow', { opacity: 0, x: -20, duration: 1 })
    rise(tl, '.s1-ask-h', 0.2)
    tl.from('.s1-ring', { scale: 0.6, opacity: 0, transformOrigin: '50% 50%', duration: 1.2, ease: 'expo.out' }, 0.9)
      .from('.s1-ask p', { opacity: 0, y: 14, duration: 1 }, 1.1)
  })

  return (
    <section className="scene scene--dark" ref={root}>
      <canvas ref={cv} className="s1-cv" aria-hidden="true" />
      <div className="s1-pad" data-interactive data-cursor={won ? undefined : 'Draw'} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="scene__in" style={{ pointerEvents: 'none' }}>
        <div className="p-eyebrow"><span>Coil</span><span>Mezo Buildathon</span></div>
        <div className="s1-stack">
          <div className="s1-ask" style={{ display: 'grid', gap: 22 }}>
            <h1 className="p-h p-h--xl s1-ask-h">Draw a <em>coil</em>.</h1>
            <p className="p-sub">One circle, anywhere. Or press Enter.</p>
            <svg className="s1-ring" width="76" height="76" viewBox="0 0 104 104" aria-hidden="true">
              <circle cx="52" cy="52" r="44" fill="none" stroke="rgba(237,237,234,0.18)" strokeWidth="2" />
              <circle ref={ringEl} cx="52" cy="52" r="44" fill="none" stroke={ORANGE} strokeWidth="3" strokeLinecap="round" strokeDasharray={2 * Math.PI * 44} strokeDashoffset={2 * Math.PI * 44} transform="rotate(-90 52 52)" />
            </svg>
          </div>
          <div className="s1-woke" style={{ visibility: 'hidden', display: 'grid', gap: 18 }}>
            <h1 className="p-h s1-woke-h">Bitcoin is the best collateral there is.</h1>
            <p className="p-h s1-sleep" style={{ color: ORANGE, fontSize: 'clamp(32px, 4.8vw, 76px)' }}>&nbsp;</p>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== 2 · 25 transactions → Coil */

function Loop({ onDone, setIntercept, setTheme, setPulse }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const cells = useRef<(HTMLElement | null)[]>([])
  const [count, setCount] = useState(0)
  const coiled = useRef(false)

  useEffect(() => {
    let n = 0, alive = true
    const run = () => {
      if (!alive || coiled.current || n >= 25) return
      n++
      setCount(n)
      const c = cells.current[n - 1]
      if (c) gsap.fromTo(c, { scale: 0.3 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' })
      if (n < 25) gsap.delayedCall(0.22, run)
    }
    const t = gsap.delayedCall(1.5, run)
    return () => { alive = false; t.kill() }
  }, [])

  const coil = () => {
    if (coiled.current) return
    coiled.current = true
    setCount(25)
    const r = root.current!.getBoundingClientRect()
    const first = cells.current[0]!.getBoundingClientRect()
    const fx = first.left + first.width / 2 - r.left, fy = first.top + first.height / 2 - r.top
    const rest = cells.current.slice(1).filter(Boolean) as HTMLElement[]
    const tl = gsap.timeline()
    tl.to(rest, {
      x: (_i: number, el: HTMLElement) => first.left - el.getBoundingClientRect().left,
      y: (_i: number, el: HTMLElement) => first.top - el.getBoundingClientRect().top,
      scale: 0.2, opacity: 0, duration: 0.7, ease: 'power3.in', stagger: { amount: 0.25, from: 'end' },
    })
      .to('.s2-copy > :not(.p-txgrid)', { opacity: 0, y: -20, duration: 0.5 }, 0)
      .to(cells.current[0], { scale: 1.8, duration: 0.3, ease: 'power2.out' }, 0.75)
      .set('.s2-flood', { visibility: 'visible' }, 0.9)
      .fromTo('.s2-flood', { clipPath: `circle(0px at ${fx}px ${fy}px)` }, { clipPath: `circle(160% at ${fx}px ${fy}px)`, duration: 1.1, ease: 'expo.inOut' }, 0.9)
      .add(() => { setTheme('accent'); setPulse() }, 1.3)
      .set('.s2-copy', { visibility: 'hidden' }, 1.6)
      .set('.s2-tag', { opacity: 0 }, 0)
      .set('.s2-reveal', { visibility: 'visible' }, 1.5)
      .fromTo('.s2-word span', { '--cw': 62, yPercent: 110 }, { '--cw': 125, yPercent: 0, duration: 1.6, ease: 'expo.out', stagger: 0.08 }, 1.5)
      .add(() => {
        const w = root.current!.querySelector('.s2-word')!.getBoundingClientRect()
        burst(cv.current!, w.left - r.left + w.width / 2, w.top - r.top + w.height / 2, ['#141414', '#141414', '#ffffff', '#fde2bd'], 320, 1.3)
      }, 1.8)
      .add(() => { gsap.set('.s2-tag', { opacity: 1 }); const t2 = gsap.timeline(); rise(t2, root.current!.querySelector('.s2-tag')!, 0) }, 2.2)
      .fromTo('.s2-meta span', { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: 0.12, duration: 0.7 }, 2.8)
      .add(() => onDone(), 3.2)
    if (reducedMotion()) tl.progress(1)
  }

  useEffect(() => {
    setIntercept(() => { if (coiled.current) return false; coil(); return true })
    return () => setIntercept(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEnter(root, (tl) => {
    rise(tl, root.current!.querySelector('.s2-h')!, 0)
    tl.from('.p-txgrid i', { scale: 0, opacity: 0, duration: 0.4, ease: 'back.out(2)', stagger: { amount: 0.5 } }, 0.6)
      .from('.s2-act', { opacity: 0, y: 12, duration: 0.8 }, 1.3)
  })

  return (
    <section className="scene scene--light" ref={root}>
      <div className="s2-flood" aria-hidden="true" />
      <canvas ref={cv} className="s1-cv" style={{ zIndex: 3, pointerEvents: 'none' }} aria-hidden="true" />
      <div className="scene__in s2-copy">
        <div className="p-eyebrow"><span>The problem</span></div>
        <h2 className="p-h s2-h">Putting it to work takes <em>25&nbsp;transactions.</em></h2>
        <div className="p-txgrid" aria-label={`${count} of 25 transactions`}>
          {Array.from({ length: 25 }, (_, i) => <i key={i} ref={(el) => { cells.current[i] = el }} className={(i < count ? 'on' : '') + (i === 0 ? ' first' : '')} />)}
        </div>
        <div className="s2-act">
          <span className="p-mono">deposit · borrow · swap · deposit · borrow · swap…</span>
          <button className="pbtn pbtn--solid is-pulse" data-cursor="Coil" onClick={coil}>Coil it</button>
        </div>
      </div>
      <div className="scene__in s2-reveal">
        <div className="word s2-word" aria-label="Coil">
          <span>C</span><span>O</span><span>I</span><span>L</span><span style={{ color: '#ffffff' }}>.</span>
        </div>
        <h2 className="p-h s2-tag">Leveraged Bitcoin in one signature.</h2>
        <div className="p-eyebrow s2-meta"><span>1 transaction</span><span>flash-swapped on Mezo</span><span>the trove stays yours</span></div>
      </div>
    </section>
  )
}

/* ================================================================== 3 · Guard, in one shot */

function GuardShot({ onDone }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const W = 1000, H = 400
  const guardY = 250, liqY = 330
  const fall = 'M0 60 L90 88 L150 74 L240 124 L300 110 L380 170 L440 154 L520 220 L560 250'
  const bounce = 'M560 250 L610 212 L680 226 L760 166 L840 180 L920 116 L1000 96'

  useEnter(root, (tl) => {
    rise(tl, root.current!.querySelector('.s3-h')!, 0)
    tl.from('.s3-line', { opacity: 0, duration: 0.8, stagger: 0.15 }, 0.5)
      .from('.s3-lab', { opacity: 0, duration: 0.5, stagger: 0.15 }, 0.8)
      .fromTo('.s3-fall', { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.7, ease: 'power2.in' }, 1.0)
      .add(() => {
        const b = svg.current!.getBoundingClientRect(), r = root.current!.getBoundingClientRect()
        burst(cv.current!, b.left - r.left + (560 / W) * b.width, b.top - r.top + (guardY / H) * b.height, [ORANGE, ORANGE, '#ffd29a', '#ededea'], 220, 1)
      }, 2.7)
      .fromTo('.s3-ring', { scale: 0.2, opacity: 1, transformOrigin: '50% 50%' }, { scale: 5, opacity: 0, duration: 1, ease: 'expo.out' }, 2.7)
      .to('.s3-liqg', { y: 36, opacity: 0.45, duration: 1.4, ease: 'power3.inOut' }, 2.8)
      .fromTo('.s3-bounce', { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.5, ease: 'power2.out' }, 2.8)
      .from('.s3-sub', { opacity: 0, y: 12, duration: 0.8 }, 3.3)
      .add(() => onDone(), 3.9)
  })

  return (
    <section className="scene scene--dark" ref={root}>
      <canvas ref={cv} className="s1-cv" style={{ zIndex: 3, pointerEvents: 'none' }} aria-hidden="true" />
      <div className="scene__in">
        <div className="p-eyebrow"><span>Guard</span></div>
        <h2 className="p-h s3-h">And when BTC falls, it <em>defends itself</em>.</h2>
        <svg ref={svg} className="p-svg s3-svg" viewBox={`0 0 ${W} ${H}`} aria-label="BTC falls, bounces off the Guard line before reaching liquidation">
          <g>
            <line className="s3-line" x1="0" x2={W} y1={guardY} y2={guardY} stroke={ORANGE} strokeWidth="2" strokeDasharray="8 6" />
            <text className="s3-lab" x={W} y={guardY - 12} textAnchor="end" style={{ font: '500 13px var(--f-mono)', letterSpacing: '0.1em', fill: ORANGE }}>YOUR GUARD</text>
          </g>
          <g className="s3-liqg">
            <line className="s3-line" x1="0" x2={W} y1={liqY} y2={liqY} stroke="#ededea" strokeOpacity="0.4" strokeWidth="1.5" strokeDasharray="3 5" />
            <text className="s3-lab" x={W} y={liqY + 24} textAnchor="end" style={{ font: '500 13px var(--f-mono)', letterSpacing: '0.1em', fill: '#8f8f98' }}>LIQUIDATION</text>
          </g>
          <path className="s3-fall" d={fall} fill="none" stroke="#ededea" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          <path className="s3-bounce" d={bounce} fill="none" stroke={ORANGE} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          <circle className="s3-ring" cx="560" cy={guardY} r="12" fill="none" stroke={ORANGE} strokeWidth="2.5" opacity="0" />
        </svg>
        <p className="p-sub s3-sub">Sign a stop-loss once. When BTC reaches it, your position unwinds itself, before liquidation ever can.</p>
      </div>
    </section>
  )
}

/* ================================================================== 4 · enter */

function Finale({ onExit, mode, onDone }: SceneProps) {
  const root = useRef<HTMLDivElement>(null)
  const rings = useRef<SVGSVGElement>(null)
  useEnter(root, (tl) => {
    tl.from('.s4-ring', { drawSVG: '0%', duration: 1.8, ease: 'expo.inOut', stagger: 0.14 }, 0)
    rise(tl, root.current!.querySelector('.s4-h')!, 0.4)
    tl.from('.p-cta .pbtn', { y: 16, opacity: 0, stagger: 0.12, duration: 0.8 }, 1.2)
      .add(() => onDone(), 1.4)
  })
  const par = (e: React.PointerEvent) => {
    const fx = e.clientX / innerWidth - 0.5, fy = e.clientY / innerHeight - 0.5
    gsap.to(rings.current, { x: fx * 50, y: fy * 34, rotate: fx * 24, duration: 1.2, ease: 'power3.out' })
  }
  const rs = useMemo(() => [180, 152, 126, 102, 80], [])
  return (
    <section className="scene scene--dark" ref={root} onPointerMove={par}>
      <svg ref={rings} viewBox="0 0 400 400" aria-hidden="true" className="s11-rings">
        {rs.map((r, i) => (
          <circle key={r} className="s4-ring" cx="200" cy="200" r={r} fill="none" stroke={i === 0 ? '#ededea' : ORANGE} strokeWidth={i === 0 ? 10 : 9 - i * 1.4} strokeLinecap="round" strokeDasharray={`${r * 5.1} ${r * 1.2}`} opacity={i === 0 ? 1 : 1 - i * 0.12} transform={`rotate(${i * 40} 200 200)`} />
        ))}
      </svg>
      <div className="scene__in">
        <div className="p-eyebrow"><span>Live on Mezo testnet</span></div>
        <h2 className="p-h p-h--xl s4-h" style={{ maxWidth: '12ch' }}>Your Bitcoin, <em>wound tight</em>.</h2>
        <div className="p-cta">
          <button className="pbtn pbtn--solid" data-cursor="Go" onClick={() => onExit?.(mode === 'deck' ? '#/' : undefined)}>Enter Coil</button>
          <button className="pbtn" data-cursor="Go" onClick={() => onExit?.('#/app')}>Open the app</button>
        </div>
      </div>
    </section>
  )
}

export const SCENES: Scene[] = [
  { id: 'wake', title: 'Wake', theme: 'dark', hint: 'Draw a circle', Component: Wake },
  { id: 'loop', title: 'Coil', theme: 'light', hint: 'Coil it', Component: Loop },
  { id: 'guard', title: 'Guard', theme: 'dark', hint: 'Watch', Component: GuardShot },
  { id: 'enter', title: 'Enter', theme: 'dark', hint: 'Enter', Component: Finale },
]
