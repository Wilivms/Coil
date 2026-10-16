import { useEffect, useRef } from 'react'
import gsap from 'gsap'

/**
 * Custom cursor: a ring that follows with lag and swells over anything marked `data-cursor`,
 * showing the verb ("Draw", "Drag", "Hold", "Click"). Hidden on touch screens.
 */
export function Cursor() {
  const ring = useRef<HTMLDivElement>(null)
  const dot = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return
    const r = ring.current!, d = dot.current!
    document.documentElement.classList.add('has-cursor')
    gsap.set([r, d], { xPercent: -50, yPercent: -50, x: innerWidth / 2, y: innerHeight / 2 })
    const rx = gsap.quickTo(r, 'x', { duration: 0.45, ease: 'power3.out' })
    const ry = gsap.quickTo(r, 'y', { duration: 0.45, ease: 'power3.out' })
    const dx = gsap.quickTo(d, 'x', { duration: 0.08 })
    const dy = gsap.quickTo(d, 'y', { duration: 0.08 })
    let current = ''
    const move = (e: PointerEvent) => {
      rx(e.clientX); ry(e.clientY); dx(e.clientX); dy(e.clientY)
      const t = (e.target as HTMLElement)?.closest?.('[data-cursor]') as HTMLElement | null
      const verb = t?.dataset.cursor ?? ''
      if (verb !== current) {
        current = verb
        if (label.current) label.current.textContent = verb
        gsap.to(r, { width: verb ? 54 : 20, height: verb ? 54 : 20, backgroundColor: verb ? 'rgba(247,147,26,0.12)' : 'rgba(247,147,26,0)', duration: 0.35, ease: 'power3.out' })
        gsap.to(label.current, { opacity: verb ? 1 : 0, duration: 0.25 })
      }
    }
    const down = () => gsap.to(r, { scale: 0.82, duration: 0.2 })
    const up = () => gsap.to(r, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.4)' })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    return () => {
      document.documentElement.classList.remove('has-cursor')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
    }
  }, [])
  return (
    <>
      <div className="cursor-ring" ref={ring} aria-hidden="true"><span ref={label} /></div>
      <div className="cursor-dot" ref={dot} aria-hidden="true" />
    </>
  )
}
