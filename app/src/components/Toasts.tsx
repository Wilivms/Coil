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
  if (/DebtTooSmall|K\b/.test(msg)) return 'The pool price moved since your signature. Refresh the quote and sign again.'
  if (/Signature expired/i.test(msg)) return 'The signature expired. Sign again.'
  if (/Invalid signature/i.test(msg)) return 'MUSD rejected the signature (nonce changed?). Sign again.'
  if (/Recovery Mode|recovery mode/i.test(msg)) return 'MUSD is in recovery mode; this operation is paused.'
  if (/insufficient funds/i.test(msg)) return 'Not enough BTC in your wallet for this amount plus gas.'
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg
}
