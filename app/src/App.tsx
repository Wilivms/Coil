import { useEffect, useState } from 'react'
import { Nav } from './components/Nav'
import { Landing } from './pages/Landing'
import { AppPage } from './pages/AppPage'
import { ProofPage } from './pages/ProofPage'
import { TryPage } from './pages/TryPage'
import { Pitch } from './pitch/Pitch'
import { reducedMotion } from './lib/motion'

type Route = 'home' | 'app' | 'pitch' | 'proof' | 'try' | 'missing'
const readRoute = (): Route => {
  const h = location.hash
  if (h.startsWith('#/app')) return 'app'
  if (h.startsWith('#/pitch')) return 'pitch'
  if (h.startsWith('#/proof')) return 'proof'
  if (h.startsWith('#/try')) return 'try'
  if (h === '' || h === '#' || h === '#/' || h.startsWith('#/?')) return 'home'
  return 'missing'
}

const TITLES: Record<Route, string> = {
  home: 'Coil · leveraged Bitcoin on Mezo that survives redemptions',
  app: 'App · Coil',
  proof: 'Proof · every Coil transaction on Mezo',
  try: 'Try Coil in 2 minutes',
  pitch: 'Pitch · Coil',
  missing: 'Page not found · Coil',
}

function Missing() {
  return (
    <main className="wrap" style={{ padding: '96px var(--gutter)', minHeight: '60vh' }}>
      <p className="mono muted">404</p>
      <h1 style={{ fontSize: 'clamp(36px, 6vw, 64px)', margin: '8px 0 16px' }}>This page doesn't exist.</h1>
      <p className="field__hint" style={{ maxWidth: 520 }}>The link may be old. Everything Coil does is one tap away:</p>
      <div className="cta-row" style={{ marginTop: 20 }}>
        <a className="btn btn--accent" href="#/app">Open the app</a>
        <a className="btn" href="#/proof">See the proof</a>
        <a className="btn btn--ghost" href="#/">Home</a>
      </div>
    </main>
  )
}

/**
 * Visitors land straight on the site (Wave 1 review: "let visitors reach the app without the
 * drawing intro"). The animated pitch is opt-in at #/pitch, or with #/?intro.
 */
function introPending() {
  if (reducedMotion() || readRoute() !== 'home') return false
  return location.hash.includes('intro')
}
function markIntroSeen() {
  try { sessionStorage.setItem('coil-intro-seen', '1') } catch { /* storage blocked */ }
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute)
  const [intro, setIntro] = useState(introPending)
  const [revealing, setRevealing] = useState(false)
  useEffect(() => { document.title = TITLES[route] }, [route])
  useEffect(() => {
    const on = () => {
      setRoute(readRoute())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const leavePitch = (to?: string) => {
    markIntroSeen()
    setIntro(false)
    setRevealing(false)
    if (to) location.hash = to
    else if (route === 'pitch') location.hash = '#/'
  }

  return (
    <>
      {(route === 'pitch' || intro) && (
        <Pitch mode={route === 'pitch' ? 'deck' : 'intro'} onExit={leavePitch} onExitStart={() => setRevealing(true)} />
      )}
      {/* Nothing runs behind the pitch; the site mounts as the exit iris starts opening. */}
      {(!(route === 'pitch' || intro) || revealing) && (
        <>
          <Nav route={route === 'home' ? 'home' : 'app'} current={route} />
          {route === 'app' ? <AppPage /> : route === 'proof' ? <ProofPage /> : route === 'try' ? <TryPage /> : route === 'missing' ? <Missing /> : <Landing />}
        </>
      )}
      <footer className="foot">
        <div className="wrap">
          <span className="mono">Coil · Mezo Buildathon · Track 1 DeFi · <a href="#/pitch">Pitch</a></span>
          <span className="foot__note">
            Testnet software, not financial advice. Leverage magnifies losses: a trove under 110% can be liquidated and
            loses its collateral. Coil never owns your trove; it only settles the flash swap inside your transaction.
          </span>
        </div>
      </footer>
    </>
  )
}
