import { useAccount, useBalance } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useActivity } from '../lib/activity'
import { useTrove } from '../lib/live'
import { mezoTestnet } from '../lib/chain'

/** Two-minute onboarding for outside testers. Each step ticks itself from the chain. */
export function TryPage() {
  const { address } = useAccount()
  const { openConnectModal } = useConnectModal()
  const bal = useBalance({ address, chainId: mezoTestnet.id, query: { refetchInterval: 10_000 } })
  const trove = useTrove(address)
  const act = useActivity()
  const mine = (act.data?.items ?? []).filter((i) => address && i.user.toLowerCase() === address.toLowerCase())
  const has = (k: string) => mine.some((i) => i.kind === k)

  const steps: { done: boolean; title: string; body: React.ReactNode; cta?: React.ReactNode }[] = [
    {
      done: !!address,
      title: 'Connect a wallet',
      body: 'Rabby, MetaMask or any EVM wallet. The app adds Mezo testnet (chain 31611) for you.',
      cta: !address && <button className="btn btn--sm" onClick={() => openConnectModal?.()}>Connect</button>,
    },
    {
      done: !!bal.data && bal.data.value >= 15n * 10n ** 15n,
      title: 'Get 0.02 test BTC',
      body: <>From the <a href="https://faucet.test.mezo.org/" target="_blank" rel="noreferrer">Mezo faucet ↗</a>. It is free test money. A trove needs about 0.012 BTC at 3×.</>,
    },
    {
      done: has('Coiled') || !!trove.data?.exists,
      title: 'Open a 3× position',
      body: 'One signature, one transaction. Your trove is opened in your own name.',
      cta: <a className="btn btn--sm" href="#/app">Open the app</a>,
    },
    {
      done: has('GuardArmed'),
      title: 'Press "Test it now" on Guard',
      body: 'It arms a stop-loss at today\'s price. The always-on keeper fires it within a minute: watch it appear in the activity list with an explorer link.',
    },
    {
      done: has('ReserveDeposited') || has('ShieldArmed'),
      title: 'Optional: fund the Reserve and arm a Shield',
      body: 'Put the MUSD you received into the Reserve (it earns sMUSD yield), then arm a Shield against redemptions.',
    },
  ]
  const done = steps.filter((s) => s.done).length

  return (
    <main className="app">
      <div className="wrap" style={{ maxWidth: 820 }}>
        <header style={{ padding: '40px 0 24px' }}>
          <p className="mono muted">Try Coil in 2 minutes · Mezo testnet</p>
          <h1 style={{ fontSize: 'clamp(32px, 5vw, 56px)', lineHeight: 1.05, margin: '8px 0 12px' }}>Leverage, then watch the keeper protect it.</h1>
          <p className="field__hint">{done} of {steps.length} done. Each step ticks itself from the chain. {act.data && <>{act.data.wallets} wallets have used Coil so far.</>}</p>
        </header>
        <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 48px', display: 'grid', gap: 12 }}>
          {steps.map((s, i) => (
            <li key={s.title} className="panel" style={{ opacity: s.done ? 0.7 : 1 }}>
              <div className="panel__b" style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 16, alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 22, color: s.done ? 'var(--ok, #3fb950)' : 'var(--accent)' }}>{s.done ? '✓' : i + 1}</span>
                <div>
                  <h3 style={{ margin: '0 0 4px' }}>{s.title}</h3>
                  <p className="field__hint" style={{ margin: 0 }}>{s.body}</p>
                </div>
                <div>{s.cta}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
  )
}
