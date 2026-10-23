import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { approvalIds, loadApprovals, waitingForMe, type Approvals } from '@/lib/approvals'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { useAsync } from '@/lib/useAsync'

// Task 2.5: the approvals list updates on its own.
// One Supabase Realtime channel per signed-in person listens for changes to the tables behind the Approvals screen
// (published by migration 20261023000100). Realtime only sends changes to rows the person may read (row-level security),
// and the change itself is not trusted for content: any change just triggers a fresh read of the list.
// "Live" is shown only once Realtime confirms it is listening to the database (its `system` message), because
// "SUBSCRIBED" alone only means the connection is open and a change made in between can be missed
// (https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting).
// Delivery is not guaranteed, so the list is also re-read: every 30 seconds while not live, every 2 minutes while live,
// and whenever the app comes back to the foreground or the network returns.

export type LiveStatus = 'connecting' | 'live' | 'offline'

export const LIVE_TABLES = ['action_requests', 'agent_registrations', 'registration_decisions'] as const
export const FALLBACK_POLL_MS = 30_000
/** Safety net while live: events are a signal, not a guarantee. */
export const LIVE_SAFETY_POLL_MS = 120_000
/** If the readiness message never comes, treat the channel as live after this long (Supabase's weaker fallback). */
export const CONFIRM_WAIT_MS = 5_000
/** How long a newly arrived item is marked "New". */
export const FRESH_MS = 60_000
/** Several changes in a burst (a request and its routing) cause one re-read. */
const DEBOUNCE_MS = 150

export type LiveEvent =
  | { kind: 'channel'; state: string } // from subscribe(): SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED
  | { kind: 'system'; extension?: string; status?: string } // Realtime's own message once the database listener is ready
  | { kind: 'no-confirmation' } // CONFIRM_WAIT_MS after SUBSCRIBED without a system message

/** What the person sees, given what the Realtime connection just reported. */
export function nextLiveStatus(current: LiveStatus, e: LiveEvent): LiveStatus {
  if (e.kind === 'channel') {
    if (e.state === 'SUBSCRIBED') return current === 'live' ? 'live' : 'connecting' // connected, not yet listening
    if (e.state === 'CHANNEL_ERROR' || e.state === 'TIMED_OUT' || e.state === 'CLOSED') return 'offline'
    return current
  }
  if (e.kind === 'system') {
    if (e.extension !== 'postgres_changes') return current
    return e.status === 'ok' ? 'live' : 'offline'
  }
  return current === 'connecting' ? 'live' : current
}

/**
 * Which items to mark "New": those that were not on the previous list, for FRESH_MS.
 * Nothing is new on the first load. Items that left the list, or have been new long enough, are dropped.
 */
export function trackFresh(fresh: Map<string, number>, previous: Set<string> | null, current: string[], now: number, ttl = FRESH_MS) {
  const next = new Map<string, number>()
  for (const id of current) {
    const since = fresh.get(id) ?? (previous && !previous.has(id) ? now : undefined)
    if (since !== undefined && now - since < ttl) next.set(id, since)
  }
  return next
}

type LiveState = {
  status: LiveStatus
  /** Goes up by one each time something changed; pages that show one item reload on it. */
  tick: number
  approvals: Approvals | null
  approvalsError: string | null
  approvalsLoading: boolean
  reloadApprovals: () => Promise<void>
  fresh: Set<string>
  waiting: number
}

const LiveContext = createContext<LiveState | null>(null)

const OFF: LiveState = {
  status: 'connecting', tick: 0, approvals: null, approvalsError: null, approvalsLoading: false,
  reloadApprovals: async () => {}, fresh: new Set(), waiting: 0,
}

export function useLive(): LiveState {
  return useContext(LiveContext) ?? OFF
}

/** `withApprovals`: keep the approvals list loaded (approvers and admins, or anyone on the Approvals screen). */
export function LiveProvider({ withApprovals, children }: { withApprovals: boolean; children: ReactNode }) {
  const { session, roles, scopeDepartmentIds } = useAuth()
  const userId = session?.user.id ?? null
  const [status, setStatus] = useState<LiveStatus>('connecting')
  const [tick, setTick] = useState(0)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changed = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setTick((t) => t + 1), DEBOUNCE_MS)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // The live connection.
  useEffect(() => {
    if (!supabase || !userId) return
    const client = supabase
    const report = (e: LiveEvent) => setStatus((s) => nextLiveStatus(s, e))
    let confirm: ReturnType<typeof setTimeout> | null = null
    let channel = client.channel(`approvals-live:${userId}`)
    for (const table of LIVE_TABLES) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, changed)
    }
    channel = channel.on('system', {}, (p: { extension?: string; status?: string }) => {
      if (p?.extension === 'postgres_changes' && confirm) { clearTimeout(confirm); confirm = null }
      report({ kind: 'system', extension: p?.extension, status: p?.status })
    })
    channel.subscribe((state) => {
      report({ kind: 'channel', state })
      if (state === 'SUBSCRIBED') {
        if (confirm) clearTimeout(confirm)
        confirm = setTimeout(() => report({ kind: 'no-confirmation' }), CONFIRM_WAIT_MS)
      }
    })
    return () => {
      if (confirm) clearTimeout(confirm)
      client.removeChannel(channel)
    }
  }, [userId, changed])

  // On becoming live: read once, in case something changed while not listening.
  useEffect(() => { if (status === 'live') changed() }, [status, changed])

  // Safety net: re-read now and then (often while not live), and when the app returns to the foreground or the network comes back.
  useEffect(() => {
    const id = setInterval(changed, status === 'live' ? LIVE_SAFETY_POLL_MS : FALLBACK_POLL_MS)
    return () => clearInterval(id)
  }, [status, changed])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') changed() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', changed)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', changed)
    }
  }, [changed])

  // The approvals list, read again after every change.
  const enabled = withApprovals && !!userId
  const { data, error, loading, reload } = useAsync(
    async () => (enabled ? loadApprovals({ userId: userId!, roles, scopeDepartmentIds }) : null),
    [enabled, userId, roles.join(), scopeDepartmentIds.join()],
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tick > 0 && enabled) reload() }, [tick])

  // What is new since the last read.
  const [fresh, setFresh] = useState<Map<string, number>>(new Map())
  const previous = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!data) { previous.current = null; return }
    const ids = approvalIds(data)
    const before = previous.current // read now: the updater below runs later, after previous is replaced
    const now = Date.now()
    setFresh((f) => trackFresh(f, before, ids, now))
    previous.current = new Set(ids)
  }, [data])
  useEffect(() => {
    if (fresh.size === 0) return
    const id = setTimeout(() => {
      const ids = previous.current
      setFresh((f) => trackFresh(f, ids, [...(ids ?? [])], Date.now()))
    }, FRESH_MS)
    return () => clearTimeout(id)
  }, [fresh])

  // The tab title shows how many things wait for this person, e.g. "(2) Agent Control Tower".
  const waiting = waitingForMe(data)
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Agent Control Tower` : 'Agent Control Tower'
  }, [waiting])
  useEffect(() => () => { document.title = 'Agent Control Tower' }, [])

  const value: LiveState = {
    status, tick, approvals: data, approvalsError: error, approvalsLoading: loading, reloadApprovals: reload,
    fresh: new Set(fresh.keys()), waiting,
  }
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
