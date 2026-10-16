import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import gsap from 'gsap'
import { reducedMotion } from '../lib/motion'

export type FlowNode = {
  tag: string
  title: string
  value: ReactNode
  sub?: ReactNode
  fn: string
}

type Wire = { d: string; a: [number, number]; b: [number, number] }

/**
 * A readable transaction graph: each node is one step of the single Coil transaction, wired in
 * execution order. Wires reroute when the grid wraps (desktop: a row; tablet: 2x2; phone: a column).
 */
export function FlowGraph({ nodes, pulseKey, footer, title, controls }: {
  nodes: FlowNode[]
  pulseKey?: string | number
  footer?: ReactNode
  title: string
  controls?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const [wires, setWires] = useState<Wire[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const o = el.getBoundingClientRect()
      setSize({ w: o.width, h: o.height })
      const next: Wire[] = []
      for (let i = 0; i < nodes.length - 1; i++) {
        const A = refs.current[i]?.getBoundingClientRect()
        const B = refs.current[i + 1]?.getBoundingClientRect()
        if (!A || !B) continue
        const sameRow = Math.abs(A.top - B.top) < 8 && B.left > A.left
        if (sameRow) {
          const a: [number, number] = [A.right - o.left, A.top + A.height / 2 - o.top]
          const b: [number, number] = [B.left - o.left, B.top + B.height / 2 - o.top]
          const dx = (b[0] - a[0]) / 2
          next.push({ a, b, d: `M${a[0]} ${a[1]} C${a[0] + dx} ${a[1]} ${b[0] - dx} ${b[1]} ${b[0]} ${b[1]}` })
        } else {
          const a: [number, number] = [A.left + A.width / 2 - o.left, A.bottom - o.top]
          const b: [number, number] = [B.left + B.width / 2 - o.left, B.top - o.top]
          const dy = Math.max(24, (b[1] - a[1]) / 2)
          next.push({ a, b, d: `M${a[0]} ${a[1]} C${a[0]} ${a[1] + dy} ${b[0]} ${b[1] - dy} ${b[0]} ${b[1]}` })
        }
      }
      setWires(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    refs.current.forEach((n) => n && ro.observe(n))
    return () => ro.disconnect()
  }, [nodes.length])

  // When the plan changes, light the nodes up in execution order.
  useEffect(() => {
    if (reducedMotion() || pulseKey === undefined) return
    const els = refs.current.filter(Boolean)
    const tl = gsap.timeline()
    tl.fromTo(
      els,
      { borderColor: 'rgba(247,147,26,0.9)' },
      { borderColor: 'rgba(255,255,255,0.08)', duration: 0.9, stagger: 0.12, ease: 'power2.out', clearProps: 'borderColor' },
    )
    return () => {
      tl.kill()
    }
  }, [pulseKey])

  const animate = !reducedMotion()
  return (
    <div className="board flow">
      <div className="board__bar">
        <span className="board__title mono"><i />{title}</span>
        {controls ?? <span className="mono">1 transaction · {nodes.length} steps</span>}
      </div>
      <div ref={box} style={{ position: 'relative' }}>
        <svg className="wires" width={size.w} height={size.h} aria-hidden="true">
          <defs>
            <linearGradient id="wireGrad" x1="0" x2="1">
              <stop offset="0" stopColor="#F7931A" stopOpacity="0.25" />
              <stop offset="1" stopColor="#F7931A" stopOpacity="0.9" />
            </linearGradient>
          </defs>
          {wires.map((w, i) => (
            <g key={i}>
              <path id={`wire-${i}`} d={w.d} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
              <path d={w.d} fill="none" stroke="url(#wireGrad)" strokeWidth="1.5" strokeDasharray="4 8" className={animate ? 'wire-flow' : ''} />
              <circle cx={w.a[0]} cy={w.a[1]} r="4.5" fill="#0c0c0e" stroke="#F7931A" strokeWidth="2" />
              <circle cx={w.b[0]} cy={w.b[1]} r="4.5" fill="#0c0c0e" stroke="#F7931A" strokeWidth="2" />
              {animate && (
                <circle r="3" fill="#F7931A">
                  <animateMotion dur="2.2s" begin={`${i * 0.45}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1">
                    <mpath href={`#wire-${i}`} />
                  </animateMotion>
                </circle>
              )}
            </g>
          ))}
        </svg>
        <div className="flow__nodes">
          {nodes.map((n, i) => (
            <div key={i} className="node" ref={(el) => { refs.current[i] = el }}>
              <div className="node__head">
                <span className="mono">{n.tag}</span>
                <span className="node__ctrl" aria-hidden="true">··· ▸</span>
              </div>
              <div className="node__title">{n.title}</div>
              <div className="node__v">
                {n.value}
                {n.sub && <small>{n.sub}</small>}
              </div>
              <div className="node__fn">{n.fn}</div>
            </div>
          ))}
        </div>
      </div>
      {footer && <div className="flow__foot">{footer}</div>}
    </div>
  )
}
