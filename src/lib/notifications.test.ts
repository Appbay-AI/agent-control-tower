import { describe, expect, it } from 'vitest'
import { badgeText, KEEP, mergeNotifications, unreadCount } from './notifications'
import type { AppNotification } from './types'

const n = (id: number, at: string, read = false): AppNotification => ({
  id, kind: 'alert', event: 'suspended', title: `T${id}`, body: 'B', url: '/agents/x', pii: false, agent_id: null, created_at: at, read_at: read ? at : null,
})

describe('in-app notifications (task 5.4)', () => {
  it('a live one goes on top; the same one twice is kept once; marking read updates it', () => {
    let list = mergeNotifications([], [n(1, '2026-11-17T10:00:00Z'), n(2, '2026-11-17T10:01:00Z')])
    list = mergeNotifications(list, [n(3, '2026-11-17T10:02:00Z')])
    list = mergeNotifications(list, [n(3, '2026-11-17T10:02:00Z')])
    expect(list.map((x) => x.id)).toEqual([3, 2, 1])
    expect(unreadCount(list)).toBe(3)
    list = mergeNotifications(list, [{ ...list[0], read_at: '2026-11-17T10:03:00Z' }])
    expect(unreadCount(list)).toBe(2)
  })
  it('keeps the latest 50 and shows 9+ over nine', () => {
    const many = Array.from({ length: 60 }, (_, i) => n(i, new Date(Date.UTC(2026, 10, 17, 0, i)).toISOString()))
    expect(mergeNotifications([], many)).toHaveLength(KEEP)
    expect(badgeText(3)).toBe('3')
    expect(badgeText(12)).toBe('9+')
  })
})
