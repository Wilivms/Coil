import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Tween a displayed number toward `target` (GSAP), so readings glide instead of jumping. */
export function useTweened(target: number, duration = 0.6): number {
  const [shown, setShown] = useState(target)
  const obj = useRef({ v: target })
  useEffect(() => {
    if (!Number.isFinite(target)) {
      setShown(target)
      return
    }
    if (reducedMotion() || !Number.isFinite(obj.current.v)) {
      obj.current.v = target
      setShown(target)
      return
    }
    const t = gsap.to(obj.current, {
      v: target,
      duration,
      ease: 'power3.out',
      onUpdate: () => setShown(obj.current.v),
    })
    return () => {
      t.kill()
    }
  }, [target, duration])
  return shown
}
