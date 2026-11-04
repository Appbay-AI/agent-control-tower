// Task 4.4: incident time to resolve and ordering.
import { describe, expect, it } from 'vitest'
import { incidentDue, sortIncidents } from './incidents'
import type { Incident } from './types'

const at = (iso: string) => Date.parse(iso)
const inc = (code: string, status: Incident['status'], due: string, opened = '2026-11-04T08:00:00Z') =>
  ({ id: code, incident_code: code, status, due_at: due, opened_at: opened }) as Incident

describe('incidents (task 4.4)', () => {
  it('says how long is left, or how late, while open; nothing once resolved', () => {
    const now = at('2026-11-04T10:00:00Z')
    expect(incidentDue(inc('a', 'open', '2026-11-05T09:00:00Z'), now)).toEqual({ text: 'Resolve within 23 h', overdue: false })
    expect(incidentDue(inc('a', 'contained', '2026-11-04T09:58:00Z'), now)).toEqual({ text: 'Overdue by 2 min', overdue: true })
    expect(incidentDue(inc('a', 'resolved', '2026-11-04T09:00:00Z'), now)).toBeNull()
  })

  it('lists open ones first, soonest due first, then the rest newest first', () => {
    const list = [
      inc('closed-old', 'closed', '2026-11-01T00:00:00Z', '2026-10-30T00:00:00Z'),
      inc('open-late', 'open', '2026-11-06T00:00:00Z'),
      inc('closed-new', 'resolved', '2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z'),
      inc('open-soon', 'contained', '2026-11-04T12:00:00Z'),
    ]
    expect(sortIncidents(list).map((i) => i.incident_code)).toEqual(['open-soon', 'open-late', 'closed-new', 'closed-old'])
  })
})
