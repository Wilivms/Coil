export const fmtUsd = (v: number, d = 0) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export const fmtNum = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export const fmtBtc = (v: number, d = 4) => fmtNum(v, d)

export const fmtPct = (v: number, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—')

export const fmtCompact = (v: number) => {
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return v.toFixed(0)
}

export const shortAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)

export const dayToDate = (day: number) =>
  new Date(day * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
