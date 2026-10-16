import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { reducedMotion } from '../lib/motion'

/** Counter loader, shown once per browser session. */
export function Loader() {
  const [show] = useState(() => {
    if (reducedMotion()) return false
    try {
      if (sessionStorage.getItem('coil-loaded')) return false
      sessionStorage.setItem('coil-loaded', '1')
    } catch { /* storage blocked: still show it */ }
    return true
  })
  const root = useRef<HTMLDivElement>(null)
  const count = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!show || !root.current) return
    const o = { v: 0 }
    const tl = gsap.timeline()
    tl.to(o, { v: 100, duration: 1.05, ease: 'power2.inOut', onUpdate: () => { if (count.current) count.current.textContent = String(Math.round(o.v)).padStart(3, '0') } })
      .to(bar.current, { scaleX: 1, duration: 1.05, ease: 'power2.inOut' }, 0)
      .to(root.current, { yPercent: -100, duration: 0.85, ease: 'expo.inOut' }, '+=0.1')
      .set(root.current, { display: 'none' })
    return () => { tl.kill() }
  }, [show])
  if (!show) return null
  return (
    <div className="loader" ref={root} aria-hidden="true">
      <div className="loader__count num" ref={count}>000</div>
      <div className="loader__bar" ref={bar} />
      <div className="loader__meta mono"><span>Coil · Mezo testnet 31611</span><span>Winding the loop</span></div>
    </div>
  )
}
