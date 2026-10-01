import { render, screen } from '@testing-library/react'
import App from '@/App'

describe('App shell', () => {
  it('shows the product name and every planned module', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Agent Control Tower' })).toBeInTheDocument()
    for (const name of ['Agent registry', 'Approvals', 'Kill switch & incidents', 'Evidence pack', 'Dashboards']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('reports a missing database configuration instead of crashing', async () => {
    render(<App />)
    expect(await screen.findByText('Database not configured')).toBeInTheDocument()
  })
})
