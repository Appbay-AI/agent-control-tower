import { act, render, screen, waitFor } from '@testing-library/react'
import { liveStatusFrom, LiveProvider, LIVE_TABLES, trackFresh, useLive } from '@/lib/live'
import { approvalIds, waitingForMe, type Approvals } from '@/lib/approvals'

// A stand-in for the Supabase Realtime channel: records what the app listens to, and lets the test fire events.
const channel = vi.hoisted(() => {
  const c = {
    listeners: [] as { filter: { table: string }; cb: () => void }[],
    onState: null as ((s: string) => void) | null,
    on(_kind: string, filter: { table: string }, cb: () => void) { c.listeners.push({ filter, cb }); return c },
    subscribe(cb: (s: string) => void) { c.onState = cb; return c },
  }
  return c
})
const removeChannel = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { channel: () => channel, removeChannel } }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: { user: { id: 'ravi' } }, roles: ['approver'], scopeDepartmentIds: [] }) }))

const load = vi.hoisted(() => vi.fn())
vi.mock('@/lib/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/approvals')>()), loadApprovals: load }))

/** A list with `n` agent actions waiting for this person. */
function list(ids: string[]): Approvals {
  return {
    myRequests: ids.map((id) => ({ req: { id } })), otherRequests: [], mine: [], others: [], dept: new Map(), people: new Map(),
  } as unknown as Approvals
}

function Probe() {
  const { status, waiting, fresh } = useLive()
  return <div><span data-testid="status">{status}</span><span data-testid="waiting">{waiting}</span><span data-testid="fresh">{[...fresh].join(',')}</span></div>
}

describe('live approvals (task 2.5)', () => {
  beforeEach(() => {
    channel.listeners = []
    channel.onState = null
    load.mockReset()
  })

  it('names the channel states the way a person would', () => {
    expect(liveStatusFrom('SUBSCRIBED')).toBe('live')
    expect(liveStatusFrom('CHANNEL_ERROR')).toBe('offline')
    expect(liveStatusFrom('TIMED_OUT')).toBe('offline')
    expect(liveStatusFrom('CLOSED')).toBe('offline')
    expect(liveStatusFrom('JOINING')).toBe('connecting')
  })

  it('marks only items that arrived after the first load as new, and only for a while', () => {
    const first = trackFresh(new Map(), null, ['a', 'b'], 1000)
    expect([...first.keys()]).toEqual([])
    const second = trackFresh(first, new Set(['a', 'b']), ['a', 'b', 'c'], 2000)
    expect([...second.keys()]).toEqual(['c'])
    // Still new 30 s later; gone after a minute; gone at once if it leaves the list.
    expect([...trackFresh(second, new Set(['a', 'b', 'c']), ['a', 'b', 'c'], 32_000).keys()]).toEqual(['c'])
    expect([...trackFresh(second, new Set(['a', 'b', 'c']), ['a', 'b', 'c'], 62_001).keys()]).toEqual([])
    expect([...trackFresh(second, new Set(['a', 'b', 'c']), ['a', 'b'], 3000).keys()]).toEqual([])
  })

  it('counts what waits for this person', () => {
    expect(waitingForMe(null)).toBe(0)
    expect(waitingForMe(list(['r1', 'r2']))).toBe(2)
    expect(approvalIds(list(['r1', 'r2']))).toEqual(['r1', 'r2'])
  })

  it('listens to the approval tables and re-reads the list when one changes', async () => {
    // First read, the read on connecting, then the read after the change.
    load.mockResolvedValueOnce(list(['r1'])).mockResolvedValueOnce(list(['r1'])).mockResolvedValue(list(['r1', 'r2']))
    const { unmount } = render(<LiveProvider withApprovals><Probe /></LiveProvider>)

    await waitFor(() => expect(screen.getByTestId('waiting')).toHaveTextContent('1'))
    expect(channel.listeners.map((l) => l.filter.table)).toEqual([...LIVE_TABLES])
    expect(screen.getByTestId('status')).toHaveTextContent('connecting')

    act(() => channel.onState!('SUBSCRIBED'))
    expect(screen.getByTestId('status')).toHaveTextContent('live')
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2)) // reads once on connecting, in case something was missed
    expect(screen.getByTestId('waiting')).toHaveTextContent('1')

    // An agent asks for something: the list is read again, the count goes up, and the new item is marked.
    act(() => channel.listeners[0].cb())
    await waitFor(() => expect(screen.getByTestId('waiting')).toHaveTextContent('2'))
    await waitFor(() => expect(screen.getByTestId('fresh')).toHaveTextContent('r2'))
    expect(document.title).toBe('(2) Agent Control Tower')

    unmount()
    expect(removeChannel).toHaveBeenCalled()
    expect(document.title).toBe('Agent Control Tower')
  })

  it('does not read the list for people who have no approvals screen', async () => {
    render(<LiveProvider withApprovals={false}><Probe /></LiveProvider>)
    act(() => channel.onState!('SUBSCRIBED'))
    act(() => channel.listeners[0].cb())
    await new Promise((r) => setTimeout(r, 300))
    expect(load).not.toHaveBeenCalled()
    expect(screen.getByTestId('waiting')).toHaveTextContent('0')
  })
})
