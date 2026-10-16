import { useEffect, useState } from 'react'
import { Nav } from './components/Nav'
import { Landing } from './pages/Landing'
import { AppPage } from './pages/AppPage'

type Route = 'home' | 'app'
const readRoute = (): Route => (location.hash.startsWith('#/app') ? 'app' : 'home')

export function App() {
  const [route, setRoute] = useState<Route>(readRoute)
  useEffect(() => {
    const on = () => {
      setRoute(readRoute())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return (
    <>
      <Nav route={route} />
      {route === 'home' ? <Landing /> : <AppPage />}
      <footer className="foot">
        <div className="wrap">
          <span className="mono">Coil · Mezo Buildathon · Track 1 DeFi</span>
          <span className="foot__note">
            Testnet software, not financial advice. Leverage magnifies losses: a trove under 110% can be liquidated and
            loses its collateral. Coil never owns your trove; it only settles the flash swap inside your transaction.
          </span>
        </div>
      </footer>
    </>
  )
}
