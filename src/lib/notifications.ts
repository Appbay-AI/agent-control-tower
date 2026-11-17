// Task 5.4: in-app notifications. One for every email; they arrive live (Supabase Realtime) and are kept newest first.
import type { AppNotification } from '@/lib/types'

export const KEEP = 50

/** Adds or updates notifications (by id), newest first, at most KEEP. */
export function mergeNotifications(list: AppNotification[], incoming: AppNotification[]): AppNotification[] {
  const byId = new Map(list.map((n) => [n.id, n]))
  for (const n of incoming) byId.set(n.id, { ...byId.get(n.id), ...n })
  return [...byId.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .slice(0, KEEP)
}

export const unreadCount = (list: AppNotification[]) => list.filter((n) => !n.read_at).length

/** "9+" over nine, so the badge stays small. */
export const badgeText = (n: number) => (n > 9 ? '9+' : String(n))
