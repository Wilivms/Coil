import { useEffect, useMemo, useRef } from 'react'
import { simulate } from '../lib/risk'
import { reducedMotion } from '../lib/motion'
import { fmtCompact, fmtPct } from '../lib/format'

/**
 * Monte Carlo field: 220 GBM price paths over the horizon, drawn in sequence. Paths that cross the
 * liquidation price turn red from the day they cross; the Guard trigger is the orange line above it.
 */
export function Fan({ s0, sigma, days, liq, trigger, seed = 11 }: {
  s0: number
  sigma: number
  days: number
  liq: number
  trigger?: number
  seed?: number
}) {
  const cv = useRef<HTMLCanvasElement>(null)
  const sim = useMemo(() => simulate(s0, sigma, days, 220, liq, seed), [s0, sigma, days, liq, seed])
  const share = useMemo(() => sim.breached.reduce((a, b) => a + b, 0) / sim.breached.length, [sim])
  const guardShare = useMemo(() => {
    if (!trigger) return 0
    let n = 0
    for (const p of sim.paths) if (p.some((x) => x <= trigger)) n++
    return n / sim.paths.length
  }, [sim, trigger])

  useEffect(() => {
    const el = cv.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let raf = 0
    let progress = reducedMotion() ? 1 : 0
    const start = performance.now()
    const W = () => el.clientWidth
    const H = () => el.clientHeight
    const resize = () => {
      el.width = W() * dpr
      el.height = H() * dpr
    }
    // Shared y-scale: 2nd to 98th percentile of the final prices, padded.
    const finals = sim.paths.map((p) => p[p.length - 1]).sort((a, b) => a - b)
    const lo = Math.min(liq * 0.85, finals[Math.floor(finals.length * 0.02)])
    const hi = Math.max(s0 * 1.15, finals[Math.floor(finals.length * 0.98)])
    const padL = 54, padR = 12, padT = 14, padB = 26

    const draw = () => {
      const w = W(), h = H()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const X = (d: number) => padL + (d / days) * (w - padL - padR)
      const Y = (v: number) => padT + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (h - padT - padB)

      ctx.font = '10px "Martian Mono Variable", "Martian Mono", monospace'
      ctx.fillStyle = 'rgba(237,237,234,0.45)'
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      for (let i = 0; i <= 4; i++) {
        const v = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * i) / 4)
        const y = Y(v)
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke()
        ctx.textAlign = 'right'
        ctx.fillText('$' + fmtCompact(v), padL - 8, y + 3)
      }
      ctx.textAlign = 'center'
      for (const d of [0, Math.round(days / 3), Math.round((2 * days) / 3), days]) ctx.fillText(d + 'd', X(d), h - 8)

      const upto = Math.max(1, Math.floor(progress * sim.paths.length))
      for (let i = 0; i < upto; i++) {
        const p = sim.paths[i]
        const bd = sim.breachDay[i]
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(237,237,234,0.14)'
        ctx.beginPath()
        const end = bd >= 0 ? bd : days
        for (let d = 0; d <= end; d++) (d ? ctx.lineTo : ctx.moveTo).call(ctx, X(d), Y(p[d]))
        ctx.stroke()
        if (bd >= 0) {
          ctx.strokeStyle = 'rgba(255,106,92,0.55)'
          ctx.beginPath()
          for (let d = bd; d <= days; d++) (d === bd ? ctx.moveTo : ctx.lineTo).call(ctx, X(d), Y(p[d]))
          ctx.stroke()
          ctx.fillStyle = '#FF6A5C'
          ctx.beginPath(); ctx.arc(X(bd), Y(p[bd]), 2, 0, Math.PI * 2); ctx.fill()
        }
      }
      const hline = (v: number, color: string, label: string, dash: number[]) => {
        if (v <= lo || v >= hi) return
        ctx.setLineDash(dash)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = color
        ctx.textAlign = 'left'
        ctx.fillText(label, padL + 6, Y(v) - 6)
      }
      hline(s0, 'rgba(237,237,234,0.8)', 'today $' + fmtCompact(s0), [])
      if (trigger) hline(trigger, '#F7931A', 'guard $' + fmtCompact(trigger), [6, 4])
      hline(liq, '#FF6A5C', 'liquidation $' + fmtCompact(liq), [3, 3])
    }

    const tick = (t: number) => {
      progress = Math.min(1, (t - start) / 1400)
      draw()
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    const ro = new ResizeObserver(() => { resize(); draw() })
    ro.observe(el)
    resize()
    if (progress < 1) raf = requestAnimationFrame(tick)
    else draw()
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [sim, s0, liq, trigger, days])

  return (
    <div className="fan">
      <canvas ref={cv} role="img" aria-label={`${sim.paths.length} simulated BTC price paths over ${days} days; ${fmtPct(share)} reach the liquidation price`} />
      <div className="fan__legend mono">
        <span><i style={{ background: 'rgba(237,237,234,0.5)' }} />Path survives</span>
        <span><i style={{ background: '#FF6A5C' }} />Hits liquidation · {fmtPct(share, 0)}</span>
        {trigger ? <span><i style={{ background: '#F7931A' }} />Guard fires first · {fmtPct(guardShare, 0)}</span> : null}
      </div>
    </div>
  )
}
