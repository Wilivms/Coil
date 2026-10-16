import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { Observer } from 'gsap/Observer'
import { SCENES, type DeckData } from './scenes'
import { Shader } from './Shader'
import { Cursor } from './Cursor'
import { useMarket, useRadar, type MarketState } from '../lib/live'
import { planOpen, WAD } from '../lib/math'
import { reducedMotion } from '../lib/motion'
import { COIL_ROUTER } from '../lib/chain'
import { fmtNum } from '../lib/format'
import './pitch.css'

gsap.registerPlugin(Observer)

const EXAMPLE: MarketState = {
  price: 82_089n * WAD, reserveMusd: 102_589_167n * WAD, reserveBtc: 1_302n * WAD, feeBps: 4n, minNetDebt: 1800n * WAD,
  interestBps: 100, tcr: 2.95, recoveryMode: false, troves: 247, block: 16_188_308n, updatedAt: 0,
}

/**
 * The pitch as an interactive journey. Nothing advances on its own: each chapter is played
 * (draw, click, drag, hold), earns sats, and the visitor moves on by scrolling, swiping,
 * arrow keys or the Next button. mode 'intro' opens onto the landing page; 'deck' is #/pitch.
 */
export function Pitch({ mode, onExit, onExitStart }: { mode: 'intro' | 'deck'; onExit: (to?: string) => void; onExitStart?: () => void }) {
  const marketQ = useMarket()
  const m = marketQ.data ?? EXAMPLE
  const radarQ = useRadar(marketQ.data?.price)
  const data: DeckData = useMemo(
    () => ({ m, plan: planOpen(m, WAD, 3), radar: radarQ.data, router: COIL_ROUTER ?? '0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16', live: !!marketQ.data }),
    [m, radarQ.data, marketQ.data],
  )

  const [idx, setIdx] = useState(0)
  const [done, setDone] = useState<Record<number, boolean>>({})
  const [sats, setSats] = useState(0)
  const [pulse, setPulse] = useState(0)
  const [heat, setHeat] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const satsEl = useRef<HTMLSpanElement>(null)
  const toast = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const dir = useRef(1)
  const exiting = useRef(false)
  const last = SCENES.length - 1
  const scene = SCENES[idx]

  const exit = useCallback((to?: string) => {
    if (exiting.current) return
    exiting.current = true
    onExitStart?.()
    if (!root.current || reducedMotion()) return onExit(to)
    gsap.to(root.current, { clipPath: 'circle(0% at 50% 50%)', duration: 1.2, ease: 'expo.inOut', onComplete: () => onExit(to) })
  }, [onExit, onExitStart])

  /** Leave the current chapter (content drifts out and blurs), then mount the next one. */
  const go = useCallback((n: number) => {
    if (busy.current || n < 0 || n > last || n === idx) return
    busy.current = true
    dir.current = n > idx ? 1 : -1
    setPulse((p) => p + 1)
    const el = layer.current
    const finish = () => { setIdx(n); setTimeout(() => { busy.current = false }, 900) } // let trackpad inertia die out
    if (!el || reducedMotion()) return finish()
    gsap.to(el, { y: -60 * dir.current, opacity: 0, duration: 0.55, ease: 'power3.in', onComplete: finish })
  }, [idx, last])

  const next = useCallback(() => (idx < last ? go(idx + 1) : mode === 'intro' ? exit() : undefined), [idx, last, go, mode, exit])
  const prev = useCallback(() => go(idx - 1), [idx, go])

  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    if (reducedMotion()) { gsap.set(el, { clearProps: 'all' }); return }
    gsap.fromTo(el, { y: 60 * dir.current, opacity: 0 }, { y: 0, opacity: 1, duration: 1, ease: 'expo.out', clearProps: 'transform' })
  }, [idx])

  /** A chapter calls this once its interaction is complete (once per chapter). */
  const doneRef = useRef<Record<number, boolean>>({})
  const satsRef = useRef(0)
  const complete = useCallback((reward: number, note?: string) => {
    if (doneRef.current[idx]) return
    doneRef.current[idx] = true
    setDone({ ...doneRef.current })
    if (reward <= 0) return // passive chapters just unlock the scroll hint
    const from = satsRef.current
    satsRef.current += reward
    setSats(satsRef.current)
    const o = { v: from }
    gsap.to(o, { v: satsRef.current, duration: 1.2, ease: 'power3.out', onUpdate: () => { if (satsEl.current) satsEl.current.textContent = fmtNum(Math.round(o.v)) } })
    if (toast.current) {
      toast.current.textContent = `+${fmtNum(reward)} sats${note ? ' · ' + note : ''}`
      gsap.killTweensOf(toast.current)
      gsap.fromTo(toast.current, { y: 20, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(2)' })
      gsap.to(toast.current, { opacity: 0, y: -10, duration: 0.6, delay: 2.6 })
    }
    setPulse((p) => p + 1)
  }, [idx])

  // Scroll / swipe / keys move between chapters; interactive areas opt out with data-interactive.
  useEffect(() => {
    // Wheel always navigates; swipes are ignored where a chapter wants the finger (drawing, dragging).
    const wheel = Observer.create({ target: window, type: 'wheel', wheelSpeed: -1, tolerance: 80, preventDefault: true, onUp: () => next(), onDown: () => prev() })
    const touch = Observer.create({
      target: window, type: 'touch', tolerance: 60, ignore: '[data-interactive], [data-interactive] *',
      onUp: () => next(), onDown: () => prev(),
    })
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) { e.preventDefault(); next() }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); prev() }
      else if (e.key === 'Escape') exit()
    }
    window.addEventListener('keydown', onKey)
    return () => { wheel.kill(); touch.kill(); window.removeEventListener('keydown', onKey) }
  }, [next, prev, exit])

  useEffect(() => {
    const o = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = o }
  }, [])

  const Cur = scene.Component
  const light = scene.theme === 'light' ? 1 : 0

  return (
    <div className="pitch" ref={root} data-theme-now={scene.theme} role="region" aria-roledescription="interactive presentation" aria-label="Coil pitch">
      <Shader light={light} pulseKey={pulse} heat={heat} />
      <div className="pitch__stage">
        <div ref={layer} key={idx} className="pitch__layer">
          <Cur data={data} onDone={complete} setHeat={setHeat} onExit={exit} mode={mode} sats={sats} done={!!done[idx]} />
        </div>
      </div>

      <div className="pitch__top">
        <span className="pitch__brand"><i />COIL</span>
        <span className="pitch__sats" title="Sats earned on this tour"><b>₿</b><span ref={satsEl}>{fmtNum(sats)}</span> sats</span>
        <span className="pitch__chap p-mono">{String(idx + 1).padStart(2, '0')} / {String(SCENES.length).padStart(2, '0')}</span>
      </div>
      <nav className="pitch__rail" aria-label="Chapters">
        {SCENES.map((s, i) => (
          <button key={s.id} className={'pitch__tick' + (i === idx ? ' is-on' : '') + (done[i] ? ' is-done' : '')} onClick={() => go(i)} aria-label={`${i + 1}. ${s.title}`} aria-current={i === idx ? 'step' : undefined}>
            <span>{s.title}</span>
          </button>
        ))}
      </nav>
      <div className="pitch__toast" ref={toast} role="status" aria-live="polite" />
      <div className="pitch__ctrl">
        <span className="pitch__count p-mono">{scene.title}</span>
        <span className={'pitch__scroll p-mono' + (done[idx] ? ' is-ready' : '')} aria-hidden="true">
          <i />{done[idx] ? 'Scroll to continue' : scene.hint}
        </span>
        <span className="pitch__btns">
          <button className="pbtn" onClick={prev} disabled={idx === 0} aria-label="Previous chapter">←</button>
          <button className={'pbtn' + (done[idx] ? ' pbtn--solid' : '')} onClick={next} aria-label="Next chapter">{idx === last ? (mode === 'intro' ? 'Enter' : 'End') : 'Next →'}</button>
          <button className="pbtn pbtn--ghost" onClick={() => exit(mode === 'deck' ? '#/app' : undefined)}>{mode === 'intro' ? 'Skip' : 'Open app'}</button>
        </span>
      </div>
      <Cursor />
    </div>
  )
}
