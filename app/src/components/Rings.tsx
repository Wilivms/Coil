import { useEffect, useRef } from 'react'
import { reducedMotion } from '../lib/motion'

/** Rotating arcs, one per BTC "layer" of the position: the deposit in ink, borrowed layers in orange. */
export function Rings({ layers, children }: { layers: number[]; children?: React.ReactNode }) {
  const cv = useRef<HTMLCanvasElement>(null)
  const state = useRef<{ w: number; rad: number; rot: number; tw: number; trad: number }[]>([])

  useEffect(() => {
    const max = Math.max(...layers, 1e-9)
    state.current = layers.slice(0, 9).map((a, i) => {
      const old = state.current[i] ?? { w: 0, rad: 0.46 - i * 0.046, rot: i * 0.9 }
      return { ...old, tw: Math.max(1.5, Math.min(22, (a / max) * 22)), trad: 0.46 - i * 0.046 }
    })
  }, [layers])

  useEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    let raf = 0
    let size = 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
    const resize = () => {
      size = el.clientWidth
      el.width = el.height = size * dpr
    }
    const draw = () => {
      if (!size) return
      const ink = css('--ink'), acc = css('--accent'), rule = css('--rule')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      const c = size / 2
      ctx.strokeStyle = rule
      ctx.lineWidth = 1
      ctx.setLineDash([2, 6])
      ctx.beginPath()
      ctx.arc(c, c, size * 0.49, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      state.current.forEach((g, i) => {
        g.w += (g.tw - g.w) * 0.08
        g.rad += (g.trad - g.rad) * 0.08
        const R = g.rad * size
        const span = Math.PI * 1.62
        ctx.lineCap = 'round'
        ctx.lineWidth = (g.w * size) / 520
        ctx.strokeStyle = i === 0 ? ink : acc
        ctx.globalAlpha = i === 0 ? 1 : Math.max(0.35, 1 - i * 0.08)
        ctx.beginPath()
        ctx.arc(c, c, R, g.rot, g.rot + span)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.fillStyle = i === 0 ? ink : acc
        ctx.beginPath()
        ctx.arc(c + Math.cos(g.rot + span) * R, c + Math.sin(g.rot + span) * R, Math.max(2.5, ctx.lineWidth * 0.6), 0, Math.PI * 2)
        ctx.fill()
      })
    }
    const tick = () => {
      state.current.forEach((g, i) => (g.rot += 0.0035 * (1 + i * 0.45) * (i % 2 ? -1 : 1)))
      draw()
      raf = requestAnimationFrame(tick)
    }
    const ro = new ResizeObserver(() => { resize(); draw() })
    ro.observe(el)
    resize()
    if (reducedMotion()) {
      state.current.forEach((g) => { g.w = g.tw; g.rad = g.trad })
      draw()
    } else raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return (
    <div className="rings" aria-hidden="true">
      <canvas ref={cv} />
      <div className="rings__center">{children}</div>
    </div>
  )
}
