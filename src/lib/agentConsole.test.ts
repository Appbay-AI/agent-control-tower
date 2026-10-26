import { consoleRuns, type ConsoleEvent } from '@/lib/agentConsole'

const req = { request_code: 'REQ-000042', description: 'Release £2,000,000 to supplier Hartwell Steel Ltd', amount: 2000000, status: 'pending' }
const ev = (over: Partial<ConsoleEvent>): ConsoleEvent => ({
  id: 1, request_id: 'r1', kind: 'asked', status: 'pending', may_proceed: false, at: '2026-10-27T09:00:00Z',
  reason: 'Value 2,000,000 GBP is outside its limits', request: req, ...over,
})

describe('agent console story (task 2.8)', () => {
  it('asked and waiting', () => {
    const [run] = consoleRuns([ev({})])
    expect(run).toMatchObject({ requestId: 'r1', code: 'REQ-000042', waiting: true })
    expect(run.steps.map((s) => s.kind)).toEqual(['asked', 'waiting'])
    expect(run.steps[0].text).toBe('Asked the Control Tower before releasing £2,000,000 to supplier Hartwell Steel Ltd. Answer: wait for a person. Value 2,000,000 GBP is outside its limits')
  })

  it('approved by a person: hears the signed decision and goes ahead', () => {
    const [run] = consoleRuns([ev({}), ev({ id: 2, kind: 'callback', status: 'approved', may_proceed: true, reason: 'Approved by Daniel Okafor: Supplier verified' })])
    expect(run.waiting).toBe(false)
    expect(run.steps.map((s) => s.kind)).toEqual(['asked', 'heard', 'acted'])
    expect(run.steps[1].text).toBe('Decision received from the Control Tower, signature checked: Approved by Daniel Okafor: Supplier verified')
    expect(run.steps[2]).toMatchObject({ proceeded: true, text: 'Going ahead: releasing £2,000,000 to supplier Hartwell Steel Ltd (simulated).' })
  })

  it('rejected: does not go ahead', () => {
    const [run] = consoleRuns([ev({}), ev({ id: 2, kind: 'callback', status: 'rejected', may_proceed: false, reason: 'Rejected by Ravi Menon: Unknown supplier' })])
    expect(run.steps.at(-1)).toMatchObject({ kind: 'acted', proceeded: false, text: 'Not going ahead. The payment is not released.' })
  })

  it('within its limits: the answer comes at once and it goes ahead', () => {
    const [run] = consoleRuns([ev({ status: 'approved', may_proceed: true, reason: 'Within its limits', request: { ...req, description: 'Release £1,000 to supplier Acme' } })])
    expect(run.steps.map((s) => s.kind)).toEqual(['asked', 'acted'])
    expect(run.steps[1]).toMatchObject({ proceeded: true })
  })

  it('newest run first', () => {
    const runs = consoleRuns([ev({ id: 1, request_id: 'old' }), ev({ id: 5, request_id: 'new' })])
    expect(runs.map((r) => r.requestId)).toEqual(['new', 'old'])
  })
})
