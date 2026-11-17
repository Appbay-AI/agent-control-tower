// Task 5.4: in-app notifications (R4.5). The bell in the header shows how many are unread; they arrive live, within
// about a second of the email being queued, through Supabase Realtime (RLS: only your own). Opening one marks it read.
import { Bell, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { badgeText, mergeNotifications, unreadCount } from '@/lib/notifications'
import { supabase } from '@/lib/supabase'
import type { AppNotification } from '@/lib/types'
import { cn } from '@/lib/utils'

const mark = (name: string) => { try { performance.mark(name) } catch { /* not available */ } }

export function NotificationBell() {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const [list, setList] = useState<AppNotification[]>([])
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    if (!userId) return
    try { const fresh = await api.notifications(); setList((l) => mergeNotifications(l, fresh)) } catch { /* the next poll tries again */ }
  }, [userId])

  useEffect(() => { void load() }, [load])
  // Live: new ones (and read marks) for this person only.
  useEffect(() => {
    if (!supabase || !userId) return
    const client = supabase
    const channel = client.channel(`notifications:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (p: { new: AppNotification }) => { mark(`act:notification:${p.new.title}`); setList((l) => mergeNotifications(l, [p.new])) })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (p: { new: AppNotification }) => setList((l) => mergeNotifications(l, [p.new])))
      .subscribe()
    // Safety net: read again now and then, and when the app comes back to the front.
    const poll = setInterval(load, 60_000)
    const onShow = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', onShow); client.removeChannel(channel) }
  }, [userId, load])
  // Closes when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const unread = unreadCount(list)
  async function read(ids: number[] | null) {
    const now = new Date().toISOString()
    setList((l) => l.map((n) => (ids === null || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)))
    try { await api.markNotificationsRead(ids) } catch { void load() }
  }

  if (!userId) return null
  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} data-testid="notification-bell"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open}
        className="relative flex size-9 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white">
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span data-testid="notification-count"
            className="bg-brand-yellow text-brand-charcoal absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold">
            {badgeText(unread)}
          </span>
        )}
      </button>
      {open && (
        <div data-testid="notification-panel" role="dialog" aria-label="Notifications"
          className="bg-card text-card-foreground absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button type="button" className="text-xs hover:underline" onClick={() => read(null)}>Mark all read</button>}
          </div>
          {list.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">Nothing yet. Requests, alerts and switch-back-on requests appear here as they happen.</p>
          ) : (
            <ul className="max-h-[70vh] divide-y overflow-y-auto">
              {list.map((n) => (
                <li key={n.id}>
                  <button type="button" data-testid="notification-item" data-unread={!n.read_at}
                    onClick={() => { setOpen(false); if (!n.read_at) void read([n.id]); navigate(n.url) }}
                    className={cn('hover:bg-muted block w-full px-3 py-2 text-left', !n.read_at && 'bg-muted/50')}>
                    <div className={cn('flex items-center gap-1.5 text-sm', !n.read_at && 'font-semibold')}>
                      {n.pii && <ShieldAlert className="size-3.5 shrink-0 text-red-700 dark:text-red-400" aria-label="Personal data" />}
                      {!n.read_at && <span className="bg-brand-yellow size-2 shrink-0 rounded-full" aria-hidden />}
                      <span className="truncate">{n.title}</span>
                    </div>
                    <div className="text-muted-foreground line-clamp-2 text-xs">{n.body}</div>
                    <div className="text-muted-foreground mt-0.5 text-[11px]">{formatDateTime(n.created_at)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
