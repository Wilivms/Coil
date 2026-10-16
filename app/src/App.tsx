import { useEffect, useState } from 'react'
import { Nav } from './components/Nav'
import { Landing } from './pages/Landing'
import { AppPage } from './pages/AppPage'
import { Pitch } from './pitch/Pitch'
import { reducedMotion } from './lib/motion'

type Route = 'home' | 'app' | 'pitch'
const readRoute = (): Route => (location.hash.startsWith('#/app') ? 'app' : location.hash.startsWith('#/pitch') ? 'pitch' : 'home')

/** The pitch plays once per browser session as the site's intro; #/pitch replays it as a deck. */
function introPending() {
  if (reducedMotion() || readRoute() !== 'home') return false
  try {
    return !sessionStorage.getItem('coil-intro-seen')
  } catch {
    return true
  }
}
function markIntroSeen() {
  try { sessionStorage.setItem('coil-intro-seen', '1') } catch { /* storage blocked */ }
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute)
  const [intro, setIntro] = useState(introPending)
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
    if (to) location.hash = to
    else if (route === 'pitch') location.hash = '#/'
  }

  return (
    <>
      {(route === 'pitch' || intro) && <Pitch mode={route === 'pitch' ? 'deck' : 'intro'} onExit={leavePitch} />}
      <Nav route={route === 'app' ? 'app' : 'home'} />
      {route === 'app' ? <AppPage /> : <Landing />}
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
