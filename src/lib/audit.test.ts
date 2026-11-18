import { describe, expect, it } from 'vitest'
import { auditCsv, changedFields, entityLabel, type AuditEntry } from '@/lib/audit'

describe('audit view (task 6.8)', () => {
  const e = { seq: 412, at: '2026-11-17T09:14:05.123Z', actor_type: 'user', actor_id: 'u', actor: 'James Whitfield', action: 'agents.update',
    entity_type: 'agents', entity_id: 'a1', agent_id: 'a1', agent: 'AGT-0001 Payment Release Assistant', summary: 'Agent updated', reason: 'Raise, then "check"',
    before: { autonomy_level: 1, name: 'X', updated_at: 'a' }, after: { autonomy_level: 2, name: 'X', updated_at: 'b' }, hash: 'h1', prev_hash: 'h0' } as AuditEntry
  it('shows what an update changed, not the timestamps', () => {
    expect(changedFields(e)).toEqual([{ field: 'autonomy_level', from: 1, to: 2 }])
    expect(changedFields({ before: null, after: { a: 1 } })).toEqual([])
  })
  it('names record types in words', () => {
    expect(entityLabel('agent_suspensions')).toBe('Suspension')
    expect(entityLabel('something_new')).toBe('Something new')
  })
  it('exports every column, with the values as JSON and quotes escaped', () => {
    const [head, line] = auditCsv([e]).split('\r\n')
    expect(head).toBe('Entry,When (UTC),Exact time (UTC),Actor type,Actor,Action,Record type,Record ID,Agent,Summary,Reason,Hash,Previous hash,Before,After')
    expect(line).toBe('412,17 Nov 2026 09:14,2026-11-17T09:14:05.123Z,Person,James Whitfield,agents.update,Agent,a1,AGT-0001 Payment Release Assistant,Agent updated,'
      + '"Raise, then ""check""",h1,h0,"{""autonomy_level"":1,""name"":""X"",""updated_at"":""a""}","{""autonomy_level"":2,""name"":""X"",""updated_at"":""b""}"')
  })
})
