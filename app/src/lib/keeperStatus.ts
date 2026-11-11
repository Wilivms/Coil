import { useQuery } from '@tanstack/react-query'

/** Live keeper health, read from the public GitHub Actions API (no token, CORS open). */
export type KeeperStatus = {
  running: boolean
  lastStart?: number // ms
  lastEnd?: number
  recent: number // completed runs looked at
  ok: number // of those, succeeded
  coveredHours: number // hours since the oldest run looked at
  gapMinutes: number // longest gap between consecutive runs
}

type Run = { status: string; conclusion: string | null; run_started_at: string; updated_at: string }

export async function fetchKeeperStatus(repo = 'Wilivms/Coil'): Promise<KeeperStatus> {
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/keeper.yml/runs?per_page=60`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!r.ok) throw new Error(`GitHub ${r.status}`)
  const runs: Run[] = (await r.json()).workflow_runs ?? []
  const done = runs.filter((x) => x.status === 'completed')
  const starts = runs.map((x) => Date.parse(x.run_started_at)).sort((a, b) => b - a)
  let gap = 0
  for (let i = 1; i < starts.length; i++) gap = Math.max(gap, starts[i - 1] - starts[i])
  return {
    running: runs.some((x) => x.status === 'in_progress' || x.status === 'queued'),
    lastStart: starts[0],
    lastEnd: done[0] ? Date.parse(done[0].updated_at) : undefined,
    recent: done.length,
    ok: done.filter((x) => x.conclusion === 'success').length,
    coveredHours: starts.length ? (Date.now() - starts[starts.length - 1]) / 3_600_000 : 0,
    gapMinutes: gap / 60_000,
  }
}

export function useKeeperStatus() {
  return useQuery({ queryKey: ['keeper-status'], queryFn: () => fetchKeeperStatus(), refetchInterval: 60_000, retry: 1 })
}
