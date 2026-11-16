import { describe, expect, it } from 'vitest'
import { groupAlertEmails } from './AgentAlertEmails'

describe('alert emails on the agent page (task 5.1)', () => {
  it('groups the emails about one event into one line with everyone told', () => {
    const at = '2026-11-16T10:00:00Z'
    const g = groupAlertEmails([
      { event: 'suspended', headline: 'AGT-0002 Invoice Matcher was suspended', person: 'Platform Admin', status: 'Sent (demo inbox)', at },
      { event: 'suspended', headline: 'AGT-0002 Invoice Matcher was suspended', person: 'James Whitfield', status: 'Sending…', at },
      { event: 'reactivated', headline: 'AGT-0002 Invoice Matcher was switched back on', person: 'Platform Admin', status: 'Sent', at: '2026-11-16T09:00:00Z' },
    ])
    expect(g.map((x) => [x.event, x.people.length])).toEqual([['suspended', 2], ['reactivated', 1]])
  })
})
