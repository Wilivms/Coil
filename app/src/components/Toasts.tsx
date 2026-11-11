import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { explorerTx } from '../lib/chain'

type Toast = { id: number; title: string; body?: string; tx?: string; kind: 'ok' | 'err' }
type Ctx = { push: (t: Omit<Toast, 'id'>) => void }

const ToastCtx = createContext<Ctx>({ push: () => {} })
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setItems((xs) => [...xs, { ...t, id }])
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === 'err' ? 9000 : 7000)
  }, [])
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={'toast' + (t.kind === 'err' ? ' toast--err' : '')}>
            <div>
              <b>{t.title}</b>
              {t.body && <span>{t.body} </span>}
              {t.tx && (
                <a href={explorerTx(t.tx)} target="_blank" rel="noreferrer">
                  View on explorer
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Turn wallet / contract errors into a sentence a person can act on. */
export function explainError(e: unknown): string {
  const msg = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e)
  if (/User rejected|denied/i.test(msg)) return 'You cancelled the request in your wallet.'
  if (/ICR < MCR|MCR is not permitted/i.test(msg)) return 'The trove would open below 110%. Lower the leverage.'
  if (/net debt must be greater/i.test(msg)) return 'Debt is under the 1,800 MUSD minimum. Deposit more BTC or raise the leverage.'
  if (/PriceDeviation/.test(msg)) return "The pool is further from MUSD's oracle than this trade allows. Refresh: the app sets the tolerance from the live quote, or wait for the pool to come back."
  if (/DebtTooSmall|K\b/.test(msg)) return 'The pool price moved since your signature. Refresh the quote and sign again.'
  if (/Slippage/.test(msg)) return 'The result would be under the minimum you signed for. Refresh the quote and sign again.'
  if (/CollateralShort/.test(msg)) return 'The BTC you would withdraw does not cover the swap at the current price. Refresh and sign again.'
  if (/NotTriggered/.test(msg)) return 'The trigger is not reached yet, so nobody can fire it.'
  if (/GuardExpired/.test(msg)) return 'This order has expired. Arm it again.'
  if (/NoGuard|NoShield/.test(msg)) return 'Nothing is armed for this trove.'
  if (/ReserveShort/.test(msg)) return 'Your Reserve holds less MUSD than this Shield repays. Add to the Reserve.'
  if (/InsufficientLiquidity/.test(msg)) return 'The pool cannot fill a trade this large. Try a smaller size.'
  if (/NothingToFlash/.test(msg)) return 'At this leverage there is nothing to borrow from the pool. Raise the leverage.'
  if (/NoDebt/.test(msg)) return 'There is no open trove for this wallet.'
  if (/BadParam/.test(msg)) return 'A parameter is out of range (for example a tolerance above 20%).'
  if (/\bBusy\b/.test(msg)) return 'Another Coil flow is running in this transaction. Try again.'
  if (/Unauthorized/.test(msg)) return 'Only the owner can do that.'
  if (/Signature expired/i.test(msg)) return 'The signature expired. Sign again.'
  if (/Invalid signature/i.test(msg)) return 'MUSD rejected the signature (nonce changed?). Sign again.'
  if (/Recovery Mode|recovery mode/i.test(msg)) return 'MUSD is in recovery mode; this operation is paused.'
  if (/insufficient funds/i.test(msg)) return 'Not enough BTC in your wallet for this amount plus gas.'
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg
}
