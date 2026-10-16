import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useMarket } from '../lib/live'

export function Nav({ route }: { route: 'home' | 'app' }) {
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
              <li><a href="#/pitch">Pitch</a></li>
            </>
          ) : (
            <>
              <li><a href="#/">Overview</a></li>
              <li><a href="#/app" aria-current="page">App</a></li>
            </>
          )}
        </ul>
        <div className="nav__right">
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
