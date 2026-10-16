import { useEffect, useMemo, useRef } from 'react'
import gsap from 'gsap'
import { reducedMotion } from '../lib/motion'
import { fmtCompact, fmtNum, dayToDate } from '../lib/format'
import type { Radar } from '../lib/live'
import { replay } from '../lib/risk'

/* ------------------------------------------------------------------ collateral ratio gauge */

const G_MIN = 1.0
const G_MAX = 3.0
const pos = (cr: number) => `${((Math.min(Math.max(cr, G_MIN), G_MAX) - G_MIN) / (G_MAX - G_MIN)) * 100}%`

export function Gauge({ cr, guardCr }: { cr: number; guardCr?: number }) {
  const needle = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!needle.current) return
    if (reducedMotion()) {
      needle.current.style.left = pos(cr)
      return
    }
    gsap.to(needle.current, { left: pos(cr), duration: 0.9, ease: 'elastic.out(1, 0.55)' })
  }, [cr])
  const seg = (a: number, b: number, color: string) => (
    <i style={{ width: `${((b - a) / (G_MAX - G_MIN)) * 100}%`, background: color }} />
  )
  return (
    <div className="gauge" role="img" aria-label={`Collateral ratio ${Number.isFinite(cr) ? (cr * 100).toFixed(0) : '—'} percent`}>
      <div className="gauge__track">
        {seg(1.0, 1.1, 'var(--danger)')}
        {seg(1.1, 1.5, 'color-mix(in srgb, var(--warn) 55%, var(--sunken))')}
        {seg(1.5, 2.0, 'var(--sunken)')}
        {seg(2.0, 3.0, 'color-mix(in srgb, var(--ok) 30%, var(--sunken))')}
      </div>
      {guardCr && Number.isFinite(guardCr) ? (
        <div className="gauge__needle" style={{ left: pos(guardCr), background: 'var(--accent)', height: 18, top: 18 }} />
      ) : null}
      <div className="gauge__needle" ref={needle} style={{ left: pos(G_MIN) }} />
      {[1.1, 1.5, 2, 3].map((v) => (
        <span key={v} className="gauge__lab" style={{ left: pos(v) }}>{Math.round(v * 100)}%</span>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ redemption radar */

export function RadarStrip({ radar, cr, self }: { radar: Radar; cr: number; self?: string }) {
  const strip = useRef<HTMLDivElement>(null)
  const bars = useMemo(() => {
    const others = radar.troves.filter((t) => !self || t.owner.toLowerCase() !== self.toLowerCase())
    const list = [...others.map((t) => ({ cr: t.cr, debt: t.debt, you: false })), { cr, debt: 0, you: true }]
    list.sort((a, b) => a.cr - b.cr)
    const maxLog = Math.max(...list.map((t) => Math.log10(1 + t.debt)), 1)
    return list.map((t) => ({ ...t, h: t.you ? 1 : 0.15 + (0.85 * Math.log10(1 + t.debt)) / maxLog }))
  }, [radar, cr, self])
  const youIdx = bars.findIndex((b) => b.you)

  useEffect(() => {
    if (reducedMotion() || !strip.current) return
    const t = gsap.from(strip.current.children, { scaleY: 0, duration: 0.6, ease: 'power3.out', stagger: { amount: 0.6 } })
    return () => { t.revert() }
  }, [radar])

  const crs = bars.filter((b) => Number.isFinite(b.cr))
  const lo = crs[0]?.cr ?? 1
  const hi = crs[crs.length - 1]?.cr ?? 3
  return (
    <div className="radar">
      <div style={{ position: 'relative' }}>
        <div className="radar__strip" ref={strip} aria-hidden="true">
          {bars.map((b, i) => (
            <i
              key={i}
              className={b.you ? 'you' : b.cr < 1.1 ? 'liq' : i < youIdx ? 'ahead' : ''}
              style={{ height: `${b.h * 100}%` }}
              title={b.you ? 'Your trove' : `${fmtNum(b.debt)} MUSD at ${(b.cr * 100).toFixed(0)}%`}
            />
          ))}
        </div>
        {youIdx >= 0 && (
          <span className="radar__you" style={{ left: `${((youIdx + 0.5) / bars.length) * 100}%` }}>you</span>
        )}
      </div>
      <div className="radar__axis">
        <span>{(lo * 100).toFixed(0)}% · redeemed first</span>
        <span>{bars.length} troves, sorted by collateral ratio</span>
        <span>{Number.isFinite(hi) ? (hi * 100).toFixed(0) + '%' : '∞'} · redeemed last</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ history replay */

export type ReplayWindow = { label: string; from: number; to?: number }

export function ReplayChart({ closes, startDay, stepDays, leverage, interestBps, win }: {
  closes: number[]
  startDay: number
  stepDays: number
  leverage: number
  interestBps: number
  win: ReplayWindow
}) {
  const fromIdx = Math.max(0, Math.round((win.from - startDay) / stepDays))
  const toIdx = win.to ? Math.min(closes.length, Math.round((win.to - startDay) / stepDays) + 1) : closes.length
  const slice = closes.slice(fromIdx, toIdx)
  const r = useMemo(() => replay(slice, leverage, interestBps, stepDays), [slice, leverage, interestBps, stepDays])
  const W = 640, H = 220, pl = 46, pr = 12, pt = 12, pb = 26
  const n = slice.length
  const yMax = Math.max(leverage * 1.05, ...r.equity) * 1.05
  const X = (i: number) => pl + (i / Math.max(1, n - 1)) * (W - pl - pr)
  const Y = (v: number) => pt + (1 - v / yMax) * (H - pt - pb)
  const line = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('')
  const area = line(r.equity) + `L${X(n - 1)} ${Y(0)}L${X(0)} ${Y(0)}Z`
  const end = r.equity[n - 1] ?? 0
  const path = useRef<SVGPathElement>(null)
  useEffect(() => {
    const p = path.current
    if (!p || reducedMotion()) return
    const len = p.getTotalLength()
    gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.2, ease: 'power2.inOut', clearProps: 'strokeDasharray,strokeDashoffset' })
  }, [win.from, win.to, leverage])
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)))
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Replay of a ${leverage.toFixed(1)}x position from ${dayToDate(win.from)}: ends at ${end.toFixed(2)} BTC per BTC deposited`}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pl} x2={W - pr} y1={Y(yMax * f)} y2={Y(yMax * f)} stroke="var(--rule)" />
            <text x={pl - 8} y={Y(yMax * f) + 3} textAnchor="end">{(yMax * f).toFixed(1)}</text>
          </g>
        ))}
        {ticks.map((i) => (
          <text key={i} x={X(i)} y={H - 8} textAnchor="middle">
            {new Date((startDay + (fromIdx + i) * stepDays) * 86_400_000).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
          </text>
        ))}
        <path d={area} fill="var(--accent-soft)" />
        <path d={line(r.hold)} fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="5 4" />
        <path ref={path} d={line(r.equity)} fill="none" stroke="var(--accent)" strokeWidth="2.25" strokeLinejoin="round" />
        {r.liquidatedAt !== null && (
          <g>
            <line x1={X(r.liquidatedAt)} x2={X(r.liquidatedAt)} y1={pt} y2={H - pb} stroke="var(--danger)" strokeDasharray="3 3" />
            <text x={X(r.liquidatedAt) + 6} y={pt + 12} style={{ fill: 'var(--danger)' }}>
              liquidated {new Date((startDay + (fromIdx + r.liquidatedAt) * stepDays) * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}
            </text>
          </g>
        )}
        <circle cx={X(n - 1)} cy={Y(end)} r="4" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
      </svg>
      <figcaption className="legend mono" style={{ marginTop: 8 }}>
        <span><i />Coil equity, BTC per BTC deposited</span>
        <span><i className="h" />Holding 1 BTC</span>
        <span>Lowest ratio {Number.isFinite(r.minCr) ? (r.minCr * 100).toFixed(0) + '%' : '—'}</span>
        <span>BTC from ${fmtCompact(slice[0] ?? 0)} to ${fmtCompact(slice[n - 1] ?? 0)}</span>
      </figcaption>
    </figure>
  )
}
