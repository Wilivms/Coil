import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { SCENES, type DeckData } from './scenes'
import { useMarket, useRadar } from '../lib/live'
import { planOpen, WAD } from '../lib/math'
import { reducedMotion } from '../lib/motion'
import { COIL_ROUTER } from '../lib/chain'
import type { MarketState } from '../lib/live'
import './pitch.css'

const EXAMPLE: MarketState = {
  price: 82_089n * WAD, reserveMusd: 102_589_167n * WAD, reserveBtc: 1_302n * WAD, feeBps: 4n, minNetDebt: 1800n * WAD,
  interestBps: 100, tcr: 2.95, recoveryMode: false, troves: 247, block: 16_188_308n, updatedAt: 0,
}

type Transition = 'iris' | 'wipe-up' | 'wipe-left' | 'split' | 'diag' | 'fade'

const CLIP: Record<Transition, [string, string]> = {
  iris: ['circle(0% at 50% 50%)', 'circle(150% at 50% 50%)'],
  'wipe-up': ['inset(100% 0% 0% 0%)', 'inset(0% 0% 0% 0%)'],
  'wipe-left': ['inset(0% 0% 0% 100%)', 'inset(0% 0% 0% 0%)'],
  split: ['inset(50% 0% 50% 0%)', 'inset(0% 0% 0% 0%)'],
  diag: ['polygon(0% 0%, 0% 0%, 0% 0%)', 'polygon(0% 0%, 260% 0%, 0% 260%)'],
  fade: ['inset(0% 0% 0% 0%)', 'inset(0% 0% 0% 0%)'],
}

/**
 * The pitch: eleven scenes, each a different motion technique, auto-advancing like stories.
 * mode 'intro' plays once over the landing page and opens onto it; mode 'deck' is the shareable
 * #/pitch link (same scenes, ends on a call to action).
 */
export function Pitch({ mode, onExit }: { mode: 'intro' | 'deck'; onExit: (to?: string) => void }) {
  const marketQ = useMarket()
  const m = marketQ.data ?? EXAMPLE
  const radarQ = useRadar(marketQ.data?.price)
  const data: DeckData = useMemo(() => {
    const plan = planOpen(m, WAD, 3)
    return { m, plan, radar: radarQ.data, router: COIL_ROUTER ?? '0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16', live: !!marketQ.data }
  }, [m, radarQ.data, marketQ.data])

  const [idx, setIdx] = useState(0)
  const [prev, setPrev] = useState<number | null>(null)
  const [playing, setPlaying] = useState(true)
  const root = useRef<HTMLDivElement>(null)
  const cur = useRef<HTMLDivElement>(null)
  const bars = useRef<(HTMLElement | null)[]>([])
  const progress = useRef<gsap.core.Tween | null>(null)
  const exiting = useRef(false)
  const last = SCENES.length - 1
  const scene = SCENES[idx]

  const exit = useCallback((to?: string) => {
    if (exiting.current) return
    exiting.current = true
    gsap.globalTimeline.resume()
    if (!root.current || reducedMotion()) return onExit(to)
    gsap.to(root.current, {
      clipPath: 'circle(0% at 50% 50%)', duration: 1.1, ease: 'expo.inOut', onComplete: () => onExit(to),
    })
  }, [onExit])

  const go = useCallback((n: number) => {
    if (n < 0 || n > last || n === idx) return
    setPrev(idx)
    setIdx(n)
  }, [idx, last])

  const next = useCallback(() => {
    if (idx < last) go(idx + 1)
    else if (mode === 'intro') exit()
  }, [idx, last, go, mode, exit])

  // Scene entrance (a different clip-path per scene) and the progress bar that drives auto-advance.
  useLayoutEffect(() => {
    bars.current.forEach((b, i) => b && gsap.set(b, { scaleX: i < idx ? 1 : 0 }))
    const el = cur.current
    if (el) {
      const [from, to] = CLIP[scene.transition]
      if (reducedMotion() || prev === null) {
        gsap.set(el, { clipPath: 'none' })
        setPrev(null)
      } else {
        gsap.fromTo(el, { clipPath: from }, {
          clipPath: to, duration: scene.transition === 'fade' ? 0.01 : 1.05, ease: 'expo.inOut',
          onComplete: () => { gsap.set(el, { clipPath: 'none' }); setPrev(null) },
        })
      }
    }
    progress.current?.kill()
    const bar = bars.current[idx]
    progress.current = bar
      ? gsap.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: scene.duration, ease: 'none', onComplete: () => next() })
      : null
    return () => { progress.current?.kill() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  // Pausing freezes every GSAP timeline at once (scenes, progress, canvases that read the ticker).
  useEffect(() => {
    if (playing) gsap.globalTimeline.resume()
    else gsap.globalTimeline.pause()
  }, [playing])
  useEffect(() => () => { gsap.globalTimeline.resume() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') go(idx - 1)
      else if (e.key.toLowerCase() === 'p') setPlaying((p) => !p)
      else if (e.key === 'Escape') exit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, go, idx, exit])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prevOverflow }
  }, [])

  const Cur = scene.Component
  const Prev = prev !== null ? SCENES[prev].Component : null

  return (
    <div className="pitch" ref={root} data-theme-now={scene.theme} role="region" aria-roledescription="presentation" aria-label="Coil pitch">
      <div className="pitch__stage">
        {Prev && prev !== null && (
          <div className="pitch__layer" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
            <Prev data={data} frozen />
          </div>
        )}
        <div ref={cur} key={idx} style={{ position: 'absolute', inset: 0 }} aria-live="polite">
          <Cur data={data} onExit={exit} mode={mode} />
        </div>
      </div>

      <div className="pitch__bars">
        {SCENES.map((s, i) => (
          <button key={s.id} className="pitch__bar" aria-label={`Go to ${s.title}`} onClick={() => go(i)}>
            <i ref={(el) => { bars.current[i] = el }} />
          </button>
        ))}
      </div>
      <div className="pitch__top">
        <span className="pitch__brand"><i />COIL</span>
        <span>{data.live ? 'Live · Mezo testnet' : 'Mezo testnet'}</span>
      </div>
      <div className="pitch__ctrl">
        <span className="pitch__count">
          <b>{String(idx + 1).padStart(2, '0')}</b><span>/ {String(SCENES.length).padStart(2, '0')} · {scene.title}</span>
        </span>
        <span className="pitch__btns">
          <span className="pitch__hint p-mono" style={{ fontSize: 11 }}>← → · P pause</span>
          <button className="pbtn" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Previous">←</button>
          <button className="pbtn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
          <button className="pbtn" onClick={next} aria-label="Next">→</button>
          <button className="pbtn pbtn--solid" onClick={() => exit(mode === 'deck' ? '#/app' : undefined)}>
            {mode === 'intro' ? 'Skip intro' : 'Open the app'}
          </button>
        </span>
      </div>
    </div>
  )
}
