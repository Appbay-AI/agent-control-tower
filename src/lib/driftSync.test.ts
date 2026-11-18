import { describe, expect, it } from 'vitest'
import { driftCsv, healthState, type DriftRow } from '@/lib/driftSync'

describe('drift report and sync health (task 6.6)', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  it('says whether each platform is fetching on time', () => {
    expect(healthState({ every_minutes: 30, failing_now: 0, last_ok: { at: '2026-11-18T11:40:00Z', message: '' } }, now)).toEqual({ state: 'healthy', text: 'Fetching on time' })
    expect(healthState({ every_minutes: 30, failing_now: 0, last_ok: { at: '2026-11-18T10:50:00Z', message: '' } }, now).state).toBe('overdue')
    expect(healthState({ every_minutes: 30, failing_now: 2, last_ok: { at: '2026-11-18T11:40:00Z', message: '' } }, now)).toEqual({ state: 'failing', text: 'The last 2 fetches failed' })
    expect(healthState({ every_minutes: 30, failing_now: 0, last_ok: null }, now).text).toBe('No good fetch yet')
    expect(healthState({ every_minutes: null, failing_now: 0, last_ok: null }, now).state).toBe('off')
  })
  it('exports the drift rows as CSV, quoting commas and quotes', () => {
    const row = { at: '2026-11-17T09:14:05Z', agent: 'AGT-0001 Payment Release Assistant', department: 'Payments', platform: 'Northbridge', external_id: 'NAP-001',
      kind: 'owner_changed', expected: 'James Whitfield', observed: 'Smith, "Jo"', actor: 'appian.admin', action: 'Recorded', result: 'Owner asked', incident: null } as unknown as DriftRow
    expect(driftCsv([row]).split('\r\n')).toEqual([
      'Detected (UTC),Agent,Department,Platform,Platform ID,What changed,Expected,Found,Who,What Control Tower did,Result,Incident',
      '17 Nov 2026 09:14,AGT-0001 Payment Release Assistant,Payments,Northbridge,NAP-001,Owner changed on its platform,James Whitfield,"Smith, ""Jo""",appian.admin,Recorded,Owner asked,',
      ''])
  })
})
