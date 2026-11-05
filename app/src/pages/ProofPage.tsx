import { COIL_LENS, COIL_ROUTER, explorerAddr, explorerTx, GAUGE_INCENTIVES, ROUTER_V1, ROUTER_V2 } from '../lib/chain'
import { DEPLOY_TX, useActivity, type ActivityItem, type ActivityKind } from '../lib/activity'
import { shortAddr } from '../lib/format'

const REPO = 'https://github.com/Wilivms/Coil'
const V2_DEPLOY_TX = '0xac47acbe97dbf0412a1f2dd2667384572529950859a518d4eb25f27afb2be6d0'
const V3_DEPLOY_TX = '0x927811a52dff769acd0458599026da14aa6ec1692012e75556ea5c19644193eb'

/** The first time each Coil flow happened on CoilRouter v2, read live from its events. */
const MILESTONES: { kind: ActivityKind; label: string; what: string }[] = [
  { kind: 'Coiled', label: 'Leveraged trove opened in one transaction', what: 'flash swap + openTroveWithSignature' },
  { kind: 'GuardArmed', label: 'Guard armed', what: 'signed AdjustTrove + trigger + minBtcOut stored' },
  { kind: 'GuardFired', label: 'Guard fired by the keeper', what: 'oracle-bounded deleverage, bounty to the keeper' },
  { kind: 'ReserveDeposited', label: 'Reserve funded', what: 'MUSD into Mezo sMUSD' },
  { kind: 'ShieldArmed', label: 'Shield armed', what: 'signed RepayMUSD with price and redemption triggers' },
  { kind: 'ShieldFired', label: 'Shield fired by the keeper', what: 'repay from the Reserve, works in Recovery Mode' },
  { kind: 'Delevered', label: 'Deleverage', what: 'adjustTroveWithSignature in a flash swap' },
  { kind: 'Relevered', label: 'Leverage up in one transaction', what: 'flash BTC in + adjustTroveWithSignature (debt increase)' },
  { kind: 'RecoilFired', label: 'Recoil fired by the keeper', what: 'back to target leverage after BTC rose or a redemption' },
  { kind: 'IncentivesPushed', label: 'MUSD sent to the MUSD/BTC gauge incentives', what: 'a share of each coil deepens the pool Coil trades on' },
  { kind: 'Unwound', label: 'Position closed in one transaction', what: 'closeTroveWithSignature in a flash swap' },
]

function firstOf(items: ActivityItem[], kind: ActivityKind) {
  const w2 = items.filter((i) => i.router !== 'v1' && i.kind === kind)
  return w2.length ? w2[w2.length - 1] : undefined // items are newest first
}

const TESTS: [string, string][] = [
  ['Keeper sandwich on a Guard is refused (the Wave 1 High)', 'test_guard_keeperSandwichReverts'],
  ['Any pool dump: a Guard never sells past the oracle bound', 'testFuzz_guardNeverSellsBelowOracleBound'],
  ['Coil still opens at the live ~2% MUSD discount', 'test_fork_coilAtRealOracleGap'],
  ['Reserve in the real sMUSD, Shield repays the real trove', 'test_fork_reserveAndShieldOnRealMezo'],
  ['Redemption queue walked on the real 350-trove list', 'test_fork_debtAheadOnRealQueue'],
  ['Shield works in Recovery Mode', 'test_shield_worksInRecoveryMode'],
  ['Pending redistribution never counted twice', 'test_closeAmount_doesNotDoubleCountPending'],
  ['Refinance + leverage up on a real trove, two signatures in one tx', 'test_fork_refinanceThenReleverOnRealMezo'],
  ['Incentives land in the real MUSD/BTC gauge contract', 'test_fork_incentivesReachRealGauge'],
  ['Recoil restores leverage after a redemption', 'test_recoil_restoresLeverageAfterRedemption'],
  ['Router never keeps BTC or MUSD, never owns a trove, Reserve always backed', 'invariant_* (random flows + pool attacks)'],
]

export function ProofPage() {
  const q = useActivity()
  const items = q.data?.items ?? []
  return (
    <main className="app">
      <div className="wrap" style={{ maxWidth: 1040 }}>
        <header style={{ padding: '40px 0 24px' }}>
          <p className="mono muted">Proof</p>
          <h1 style={{ fontSize: 'clamp(32px, 5vw, 56px)', lineHeight: 1.05, margin: '8px 0 12px' }}>Everything Coil claims, with a link.</h1>
          <p className="field__hint" style={{ maxWidth: 680 }}>
            Every line below is either an on-chain transaction on Mezo testnet or a test you can run. Numbers update live from CoilRouter's events.
          </p>
        </header>

        <div className="kpis" style={{ border: '1px solid var(--rule)', borderRadius: 4, marginBottom: 24 }}>
          <div className="kpi kpi--accent"><span className="mono">Wallets</span><span className="kpi__v">{q.data?.wallets ?? '…'}</span><span className="kpi__s">that used Coil (all versions)</span></div>
          <div className="kpi"><span className="mono">Transactions</span><span className="kpi__v">{q.data?.total ?? '…'}</span><span className="kpi__s">CoilRouter calls</span></div>
          <div className="kpi"><span className="mono">Keeper fires</span><span className="kpi__v">{q.data?.fires ?? '…'}</span><span className="kpi__s">Guards, Shields and Recoils run by the keeper</span></div>
          <div className="kpi"><span className="mono">Wallets in Wave 2</span><span className="kpi__v">{q.data?.walletsV2 ?? '…'}</span><span className="kpi__s">since Nov 4, 2026</span></div>
        </div>

        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel__h"><h2>Contracts</h2><span className="pill" data-s="ok">Source-verified</span></div>
          <div className="panel__b">
            <div className="rows">
              {COIL_ROUTER && <div className="row"><span>CoilRouter v3 (Wave 2, current)</span><a className="mono" href={`${explorerAddr(COIL_ROUTER)}#code`} target="_blank" rel="noreferrer">{shortAddr(COIL_ROUTER)} ↗</a></div>}
              <div className="row"><span>CoilLens (status views)</span><a className="mono" href={`${explorerAddr(COIL_LENS)}#code`} target="_blank" rel="noreferrer">{shortAddr(COIL_LENS)} ↗</a></div>
              <div className="row"><span>v3 deploy transaction (block 16559650)</span><a className="mono" href={explorerTx(V3_DEPLOY_TX)} target="_blank" rel="noreferrer">{shortAddr(V3_DEPLOY_TX)} ↗</a></div>
              <div className="row"><span>CoilRouter v2 (Wave 2, first release: first Guard fire)</span><a className="mono" href={`${explorerAddr(ROUTER_V2)}#code`} target="_blank" rel="noreferrer">{shortAddr(ROUTER_V2)} ↗</a></div>
              <div className="row"><span>MUSD/BTC gauge incentives Coil pays into</span><a className="mono" href={explorerAddr(GAUGE_INCENTIVES)} target="_blank" rel="noreferrer">{shortAddr(GAUGE_INCENTIVES)} ↗</a></div>
              <div className="row"><span>v2 deploy transaction (block 16558220)</span><a className="mono" href={explorerTx(V2_DEPLOY_TX)} target="_blank" rel="noreferrer">{shortAddr(V2_DEPLOY_TX)} ↗</a></div>
              <div className="row"><span>CoilRouter v1 (Wave 1)</span><a className="mono" href={explorerAddr(ROUTER_V1)} target="_blank" rel="noreferrer">{shortAddr(ROUTER_V1)} ↗</a></div>
              <div className="row"><span>v1 deploy transaction</span><a className="mono" href={explorerTx(DEPLOY_TX)} target="_blank" rel="noreferrer">{shortAddr(DEPLOY_TX)} ↗</a></div>
              <div className="row"><span>Immutable, no proxy, no forwarder, no admin path to funds</span><a className="mono" href={`${REPO}/blob/main/docs/security/threat-model.md`} target="_blank" rel="noreferrer">threat model ↗</a></div>
            </div>
          </div>
        </section>

        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel__h"><h2>Every flow, run on-chain</h2><span className="mono muted">first occurrence in Wave 2 (v2 or v3)</span></div>
          <div className="panel__b">
            <ol className="act act--steps">
              {MILESTONES.map((m) => {
                const f = firstOf(items, m.kind)
                return (
                  <li key={m.kind}>
                    <span className="act__k" data-k={m.kind}>{f ? '✓' : '…'}</span>
                    <span className="act__d">{m.label} <span className="faint">· {m.what}</span></span>
                    <span className="act__m mono muted">{f ? shortAddr(f.user) : q.isLoading ? 'reading the chain' : 'not yet'}</span>
                    {f ? <a className="act__tx mono" href={explorerTx(f.tx)} target="_blank" rel="noreferrer">{shortAddr(f.tx)} ↗</a> : <span />}
                  </li>
                )
              })}
            </ol>
          </div>
        </section>

        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel__h">
            <h2>Tests that back the claims</h2>
            <a className="mono" href={`${REPO}/actions/workflows/ci.yml`} target="_blank" rel="noreferrer">CI runs ↗</a>
          </div>
          <div className="panel__b">
            <div className="rows">
              {TESTS.map(([what, name]) => (
                <div className="row" key={name}><span>{what}</span><code className="muted" style={{ fontSize: 12, textTransform: 'none', overflowWrap: 'anywhere', textAlign: 'right' }}>{name}</code></div>
              ))}
            </div>
            <p className="field__hint" style={{ margin: 0 }}>
              Run them: <code>cd contracts &amp;&amp; forge test</code>, and the fork suite against live Mezo testnet with <code>--match-path "test/fork/*" --fork-url https://rpc.test.mezo.org</code>. CI runs both on every push.
            </p>
          </div>
        </section>

        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel__h">
            <h2>Always-on keeper</h2>
            <a className="mono" href={`${REPO}/actions/workflows/keeper.yml`} target="_blank" rel="noreferrer">keeper runs ↗</a>
          </div>
          <div className="panel__b">
            <p className="field__hint" style={{ margin: 0 }}>
              A GitHub Action polls Mezo every 15 seconds and chains itself run after run. It fires any Guard, Shield or Recoil whose condition holds and pushes the gauge incentives; the contract re-checks the condition, so a keeper can only fire what is due. Anyone can run the same script from <code>keeper/</code>.
            </p>
          </div>
        </section>

        <section className="panel" style={{ marginBottom: 48 }}>
          <div className="panel__h"><h2>Why redemptions</h2><span className="mono muted">Mezo mainnet, read on-chain</span></div>
          <div className="panel__b">
            <div className="rows">
              <div className="row"><span>Redemptions vs liquidations, all time</span><span>1,176 vs 28</span></div>
              <div className="row"><span>MUSD redeemed / BTC taken from troves</span><span>5.9M MUSD / 78.9 BTC</span></div>
              <div className="row"><span>Troves still open on mainnet</span><span>3</span></div>
            </div>
            <p className="field__hint" style={{ margin: 0 }}>
              Reprint with the block number: <code>cd keeper &amp;&amp; npm ci &amp;&amp; npm run stats</code>.
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}
