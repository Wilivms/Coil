import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { reducedMotion } from '../lib/motion'

gsap.registerPlugin(ScrollTrigger)

/**
 * The wordmark is a spring: it uncoils from condensed to extended on load, contracts under the
 * cursor and compresses as the hero scrolls away (Archivo's width axis, 62 to 125).
 */
export function Wordmark({ trigger }: { trigger?: string }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return
    const chars = Array.from(el.querySelectorAll<HTMLSpanElement>('span'))
    const ctx = gsap.context(() => {
      gsap.fromTo(
        chars,
        { '--cw': 62, yPercent: 40, opacity: 0 },
        { '--cw': 125, yPercent: 0, opacity: 1, duration: 1.4, ease: 'expo.out', stagger: 0.07, delay: 0.15 },
      )
      if (trigger) {
        const state = { w: 125 }
        gsap.to(state, {
          w: 62,
          ease: 'none',
          scrollTrigger: { trigger, start: 'top top', end: 'bottom top', scrub: true },
          onUpdate: () => chars.forEach((c) => c.style.setProperty('--cw', String(state.w))),
        })
      }
    }, el)
    const enter = (c: HTMLSpanElement) => () => gsap.to(c, { '--cw': 70, duration: 0.4, ease: 'power3.out' })
    const leave = (c: HTMLSpanElement) => () => gsap.to(c, { '--cw': 125, duration: 0.9, ease: 'elastic.out(1, 0.4)' })
    const offs = chars.map((c) => {
      const a = enter(c), b = leave(c)
      c.addEventListener('mouseenter', a)
      c.addEventListener('mouseleave', b)
      return () => { c.removeEventListener('mouseenter', a); c.removeEventListener('mouseleave', b) }
    })
    return () => { ctx.revert(); offs.forEach((f) => f()) }
  }, [trigger])
  return (
    <div className="word" ref={ref} role="img" aria-label="Coil">
      <span>C</span><span>O</span><span>I</span><span>L</span><span className="stop">.</span>
    </div>
  )
}
