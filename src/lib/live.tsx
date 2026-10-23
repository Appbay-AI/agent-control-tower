import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { approvalIds, loadApprovals, waitingForMe, type Approvals } from '@/lib/approvals'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { useAsync } from '@/lib/useAsync'

// Task 2.5: the approvals list updates on its own.
// One Supabase Realtime channel per signed-in person listens for changes to the tables behind the Approvals screen
// (published by migration 20261023000100). Realtime only sends changes to rows the person may read (row-level security),
// and the change itself is not trusted for content: any change just triggers a fresh read of the list.
// If the live connection drops (phone asleep, network change), the list is re-read every 30 seconds and whenever the
// app comes back to the foreground, so nothing is missed.

export type LiveStatus = 'connecting' | 'live' | 'offline'

export const LIVE_TABLES = ['action_requests', 'agent_registrations', 'registration_decisions'] as const
export const FALLBACK_POLL_MS = 30_000
/** How long a newly arrived item is marked "New". */
export const FRESH_MS = 60_000
/** Several changes in a burst (a request and its routing) cause one re-read. */
const DEBOUNCE_MS = 150

/** Maps the Realtime channel state to what the person sees. */
export function liveStatusFrom(channelState: string): LiveStatus {
  if (channelState === 'SUBSCRIBED') return 'live'
  if (channelState === 'CHANNEL_ERROR' || channelState === 'TIMED_OUT' || channelState === 'CLOSED') return 'offline'
  return 'connecting'
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
    let channel = client.channel(`approvals-live:${userId}`)
    for (const table of LIVE_TABLES) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, changed)
    }
    channel.subscribe((state) => {
      const next = liveStatusFrom(state)
      setStatus(next)
      // (Re)connected: read once, in case something changed while not listening.
      if (next === 'live') changed()
    })
    return () => { client.removeChannel(channel) }
  }, [userId, changed])

  // Safety net while not live, and whenever the app returns to the foreground or the network comes back.
  useEffect(() => {
    if (status === 'live') return
    const id = setInterval(changed, FALLBACK_POLL_MS)
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
