import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RequestDecisionPanel } from '@/components/RequestDecisionPanel'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { decideRequest: vi.fn(async () => 'approved'), escalateRequest: vi.fn(async () => null) } }))

const targets = [{ id: 'daniel', full_name: 'Daniel Okafor', job_title: 'Payments Risk Lead' }]
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

describe('approver decision panel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('approves with an optional note', async () => {
    const onDone = vi.fn()
    render(<RequestDecisionPanel requestId="r1" agentLive targets={targets} onDone={onDone} />)
    click('Approve')
    click('Confirm approval')
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('approve'))
    expect(api.decideRequest).toHaveBeenCalledWith('r1', 'approve', null)
  })

  it('will not reject without a reason', () => {
    render(<RequestDecisionPanel requestId="r1" agentLive targets={targets} onDone={vi.fn()} />)
    click('Reject')
    click('Confirm rejection')
    expect(screen.getByText(/Say why it is rejected/)).toBeInTheDocument()
    expect(api.decideRequest).not.toHaveBeenCalled()
  })

  it('escalates to the chosen approver with a reason', async () => {
    const onDone = vi.fn()
    render(<RequestDecisionPanel requestId="r1" agentLive targets={targets} onDone={onDone} />)
    click('Escalate')
    click('Escalate')
    expect(screen.getByText('Choose who to escalate to.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Escalate to'), { target: { value: 'daniel' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  New supplier  ' } })
    click('Escalate')
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('escalate'))
    expect(api.escalateRequest).toHaveBeenCalledWith('r1', 'daniel', 'New supplier')
  })

  it('offers only rejection once the agent is no longer Live', () => {
    render(<RequestDecisionPanel requestId="r1" agentLive={false} targets={targets} onDone={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })
})
