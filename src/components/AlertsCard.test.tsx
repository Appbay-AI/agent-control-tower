import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AlertsCard } from '@/components/AlertsCard'
import { api } from '@/lib/api'
import * as push from '@/lib/push'

vi.mock('@/lib/api', () => ({ api: { pushSendTest: vi.fn(async () => null) } }))
vi.mock('@/lib/push', async (orig) => ({
  ...(await orig<typeof import('@/lib/push')>()),
  browserFacts: vi.fn(),
  currentSubscription: vi.fn(async () => null),
  turnOnAlerts: vi.fn(async () => ({})),
  turnOffAlerts: vi.fn(async () => undefined),
}))

const facts = (over: Partial<push.BrowserFacts> = {}): push.BrowserFacts => ({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130', touchMac: false, standalone: false,
  hasServiceWorker: true, hasPush: true, hasNotification: true, permission: 'default', ...over,
})

describe('alerts card (task 2.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(push.browserFacts).mockReturnValue(facts())
  })

  it('turns alerts on, then sends a test and turns them off', async () => {
    render(<AlertsCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on alerts' }))
    await screen.findByText('Alerts are on. Send a test to check.')
    expect(push.turnOnAlerts).toHaveBeenCalledOnce()
    expect(screen.getByTestId('alerts-state')).toHaveTextContent('Alerts are on for this device.')

    fireEvent.click(screen.getByRole('button', { name: 'Send a test alert' }))
    await screen.findByText('Test alert sent. It should arrive in a few seconds.')
    expect(api.pushSendTest).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await screen.findByText('Alerts are off for this device.')
    expect(push.turnOffAlerts).toHaveBeenCalledOnce()
  })

  it('shows "on" when this device already has alerts', async () => {
    vi.mocked(push.currentSubscription).mockResolvedValueOnce({} as PushSubscription)
    render(<AlertsCard />)
    expect(await screen.findByRole('button', { name: 'Send a test alert' })).toBeInTheDocument()
  })

  it('tells iPhone users to add the app to the Home Screen, with no button that cannot work', async () => {
    vi.mocked(push.browserFacts).mockReturnValue(facts({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1', hasPush: false }))
    render(<AlertsCard />)
    expect(await screen.findByTestId('alerts-state')).toHaveTextContent('add this app to your Home Screen first')
    expect(screen.queryByRole('button', { name: 'Turn on alerts' })).toBeNull()
  })

  it('explains a refusal in plain words', async () => {
    vi.mocked(push.turnOnAlerts).mockRejectedValueOnce(new Error('Alerts are blocked for this site. Allow notifications in the browser or phone settings, then try again.'))
    render(<AlertsCard />)
    vi.mocked(push.browserFacts).mockReturnValue(facts({ permission: 'denied' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on alerts' }))
    await waitFor(() => expect(screen.getByTestId('alerts-state')).toHaveTextContent('Alerts are blocked for this site'))
    expect(screen.getByRole('status')).toHaveTextContent('Allow notifications in the browser or phone settings')
  })
})
