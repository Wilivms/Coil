import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { Observer } from 'gsap/Observer'
import { SCENES, type DeckData, type Theme } from './scenes'
import { Shader } from './Shader'
import { Cursor } from './Cursor'
import { useMarket, type MarketState } from '../lib/live'
import { planOpen, WAD } from '../lib/math'
import { reducedMotion } from '../lib/motion'
import { COIL_ROUTER } from '../lib/chain'
import './pitch.css'

gsap.registerPlugin(Observer)

const EXAMPLE: MarketState = {
  price: 82_089n * WAD, reserveMusd: 102_589_167n * WAD, reserveBtc: 1_302n * WAD, feeBps: 4n, minNetDebt: 1800n * WAD,
  interestBps: 100, tcr: 2.95, recoveryMode: false, troves: 247, block: 16_188_308n, updatedAt: 0,
}

/**
 * A short, interactive intro: four beats (draw a coil, 25 transactions collapse into one,
 * Guard catches a crash, enter). Scrolling on a chapter whose moment hasn't played yet plays it,
 * so nobody skips the effect; the next scroll moves on. mode 'intro' opens onto the landing; 'deck' is #/pitch.
 */
export function Pitch({ mode, onExit, onExitStart }: { mode: 'intro' | 'deck'; onExit: (to?: string) => void; onExitStart?: () => void }) {
  const marketQ = useMarket()
  const m = marketQ.data ?? EXAMPLE
  const data: DeckData = useMemo(
    () => ({ m, plan: planOpen(m, WAD, 3), router: COIL_ROUTER ?? '0x46a1B46016cF0C0E328Aa5D304F2f11257B21A16', live: !!marketQ.data }),
    [m, marketQ.data],
  )

  const [idx, setIdx] = useState(0)
  const [done, setDone] = useState<Record<number, boolean>>({})
  const [pulse, setPulseN] = useState(0)
  const [themeOverride, setThemeOverride] = useState<Theme | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const dir = useRef(1)
  const exiting = useRef(false)
  const intercept = useRef<(() => boolean) | null>(null)
  const last = SCENES.length - 1
  const scene = SCENES[idx]
  const theme = themeOverride ?? scene.theme

  const exit = useCallback((to?: string) => {
    if (exiting.current) return
    exiting.current = true
    onExitStart?.()
    if (!root.current || reducedMotion()) return onExit(to)
    gsap.to(root.current, { clipPath: 'circle(0% at 50% 50%)', duration: 1.2, ease: 'expo.inOut', onComplete: () => onExit(to) })
  }, [onExit, onExitStart])

  const go = useCallback((n: number) => {
    if (busy.current || n < 0 || n > last || n === idx) return
    busy.current = true
    dir.current = n > idx ? 1 : -1
    setPulseN((p) => p + 1)
    const el = layer.current
    const finish = () => { intercept.current = null; setThemeOverride(null); setIdx(n); setTimeout(() => { busy.current = false }, 900) }
    if (!el || reducedMotion()) return finish()
    gsap.to(el, { y: -60 * dir.current, opacity: 0, duration: 0.55, ease: 'power3.in', onComplete: finish })
  }, [idx, last])

  const cooldown = () => { busy.current = true; setTimeout(() => { busy.current = false }, 1400) }
  const next = useCallback(() => {
    if (busy.current) return
    // first scroll on a chapter plays its moment instead of skipping it
    if (intercept.current?.()) return cooldown()
    if (idx < last) go(idx + 1)
    else if (mode === 'intro') exit()
  }, [idx, last, go, mode, exit])
  const prev = useCallback(() => go(idx - 1), [idx, go])

  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    if (reducedMotion()) { gsap.set(el, { clearProps: 'all' }); return }
    gsap.fromTo(el, { y: 60 * dir.current, opacity: 0 }, { y: 0, opacity: 1, duration: 1, ease: 'expo.out', clearProps: 'transform' })
  }, [idx])

  const complete = useCallback(() => { setDone((d) => (d[idx] ? d : { ...d, [idx]: true })) }, [idx])
  const setIntercept = useCallback((fn: (() => boolean) | null) => { intercept.current = fn }, [])
  const setPulse = useCallback(() => setPulseN((p) => p + 1), [])

  useEffect(() => {
    const wheel = Observer.create({ target: window, type: 'wheel', wheelSpeed: -1, tolerance: 80, preventDefault: true, onUp: () => next(), onDown: () => prev() })
    const touch = Observer.create({
      target: window, type: 'touch', tolerance: 60, ignore: '[data-interactive], [data-interactive] *',
      onUp: () => next(), onDown: () => prev(),
    })
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next() }
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

  return (
    <div className="pitch" ref={root} data-theme-now={theme} role="region" aria-roledescription="interactive presentation" aria-label="Coil intro">
      <Shader light={scene.theme === 'light' ? 1 : 0} pulseKey={pulse} heat={0} />
      <div className="pitch__stage">
        <div ref={layer} key={idx} className="pitch__layer">
          <Cur data={data} onDone={complete} setIntercept={setIntercept} setTheme={setThemeOverride} setPulse={setPulse} onExit={exit} mode={mode} />
        </div>
      </div>

      <div className="pitch__top">
        <span className="pitch__brand"><i />COIL</span>
        <span className="pitch__dots" aria-label={`Chapter ${idx + 1} of ${SCENES.length}`}>
          {SCENES.map((s, i) => <i key={s.id} className={(i === idx ? 'is-on' : '') + (i < idx || done[i] ? ' is-done' : '')} />)}
        </span>
      </div>
      <div className="pitch__ctrl">
        <span />
        <span className={'pitch__scroll p-mono' + (done[idx] ? ' is-ready' : '')} aria-hidden="true">
          <i />{done[idx] ? (idx === last ? 'Scroll to enter' : 'Scroll to continue') : scene.hint}
        </span>
        <span className="pitch__btns">
          <button className="pbtn pbtn--ghost" onClick={() => exit(mode === 'deck' ? '#/app' : undefined)}>{mode === 'intro' ? 'Skip intro' : 'Open app'}</button>
        </span>
      </div>
      <Cursor />
    </div>
  )
}
