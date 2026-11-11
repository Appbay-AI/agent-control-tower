// Task 4.5: the case form sends only what changed; the status buttons know what is missing.
import { describe, expect, it } from 'vitest'
import { missingFor } from '@/lib/incidents'
import type { Incident } from '@/lib/types'
import { changedFields, draftOf } from './IncidentPage'

const base = { impact: null, customers_affected: null, financial_impact: null, personal_data: null, containment: null,
  root_cause_category: null, root_cause: null, remediation: null } as unknown as Incident

describe('incident case form (task 4.5)', () => {
  it('sends only changed fields, trimmed; clearing a field sends ""', () => {
    const saved = draftOf({ ...base, impact: '12 customers', customers_affected: 12 })
    expect(saved).toMatchObject({ impact: '12 customers', customers_affected: '12', financial_impact: '' })
    expect(changedFields(saved, { ...saved, impact: '12 customers ' })).toEqual({})
    expect(changedFields(saved, { ...saved, containment: ' Agent suspended ', customers_affected: '' }))
      .toEqual({ containment: 'Agent suspended', customers_affected: '' })
  })

  it('knows what is missing before containing or resolving (as the database does)', () => {
    expect(missingFor(base, 'contained')).toEqual(['containment'])
    expect(missingFor({ ...base, containment: 'x' }, 'resolved'))
      .toEqual(['impact', 'whether personal data was involved', 'root cause category', 'root cause', 'remediation'])
    expect(missingFor({ ...base, containment: 'x', impact: 'y', personal_data: 'no', root_cause_category: 'other', root_cause: 'z', remediation: 'w' }, 'resolved')).toEqual([])
  })
})
