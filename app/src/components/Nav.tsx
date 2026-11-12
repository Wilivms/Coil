import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useMarket } from '../lib/live'
import { setTheme, useTheme } from '../lib/theme'

function ThemeToggle() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button className="theme-toggle" onClick={() => setTheme(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></g></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20.2 14.6A8.5 8.5 0 0 1 9.4 3.8a8.5 8.5 0 1 0 10.8 10.8Z" fill="currentColor" /></svg>
      )}
    </button>
  )
}

export function Nav({ route, current }: { route: 'home' | 'app'; current?: string }) {
  const market = useMarket()
  const live = market.isSuccess && !market.isError
  return (
    <nav className="nav">
      <div className="wrap nav__in">
        <a className="brand" href="#/" aria-label="Coil home">
          <span className="brand__mark" />
          COIL
        </a>
        <ul className="nav__links mono">
          {route === 'home' ? (
            <>
              <li><a href="#how">How it works</a></li>
              <li><a href="#guard">Guard</a></li>
              <li><a href="#risk">Risk</a></li>
              <li><a href="#/proof">Proof</a></li>
              <li><a href="#/try">Try it</a></li>
            </>
          ) : (
            <>
              <li><a href="#/">Overview</a></li>
              <li><a href="#/app" aria-current={current === 'app' ? 'page' : undefined}>App</a></li>
              <li><a href="#/proof" aria-current={current === 'proof' ? 'page' : undefined}>Proof</a></li>
              <li><a href="#/try" aria-current={current === 'try' ? 'page' : undefined}>Try it</a></li>
            </>
          )}
        </ul>
        <div className="nav__right">
          <ThemeToggle />
          <span className="chip mono" title={live ? `Block ${market.data?.block}` : 'Reading Mezo testnet'}>
            <span className={'dot' + (live ? '' : ' dot--off')} />
            {live ? 'Mezo testnet live' : 'Connecting'}
          </span>
          {route === 'home' ? (
            <a className="btn btn--sm" href="#/app">Launch app</a>
          ) : (
            <ConnectButton.Custom>
              {({ account, chain, openConnectModal, openAccountModal, openChainModal, mounted }) => {
                if (!mounted) return null
                if (!account) return <button className="btn btn--sm" onClick={openConnectModal}>Connect wallet</button>
                if (chain?.unsupported) return <button className="btn btn--sm btn--accent" onClick={openChainModal}>Switch to Mezo</button>
                return (
                  <button className="btn btn--sm btn--ghost num" onClick={openAccountModal}>
                    {account.displayName}
                  </button>
                )
              }}
            </ConnectButton.Custom>
          )}
        </div>
      </div>
    </nav>
  )
}
