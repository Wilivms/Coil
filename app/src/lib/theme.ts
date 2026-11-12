import { useSyncExternalStore } from 'react'

// Theme: the visitor's choice (saved in this browser) wins; otherwise the system setting.
// index.html applies the saved choice before the first paint, so there is no flash.
export type Theme = 'light' | 'dark'
const KEY = 'coil-theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

export function currentTheme(): Theme {
  return saved() ?? (media().matches ? 'dark' : 'light')
}

const listeners = new Set<() => void>()
function emit() { listeners.forEach((l) => l()) }

function apply(t: Theme) {
  document.documentElement.dataset.theme = t
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', t === 'dark' ? '#0e0e10' : '#f4f4f1'))
}

export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t) } catch { /* private mode: still switch for this visit */ }
  apply(t)
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  const mq = media()
  const onSystem = () => { if (!saved()) { apply(currentTheme()); emit() } }
  mq.addEventListener('change', onSystem)
  return () => { listeners.delete(l); mq.removeEventListener('change', onSystem) }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => 'light')
}
