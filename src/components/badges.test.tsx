import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SourceBadge } from './badges'

describe('source badge (task 3.6)', () => {
  it('names the platform an agent comes from, or how it was registered', () => {
    const text = (p: string | null, s: 'manual' | 'api' | 'discovered') => {
      const { unmount } = render(<SourceBadge platform={p} source={s} />)
      const t = screen.getByTestId('source-badge').textContent
      unmount()
      return t
    }
    expect(text('Northbridge Agent Platform (simulated)', 'discovered')).toBe('Northbridge Agent Platform (simulated) (auto)')
    expect(text('Northbridge Agent Platform (simulated)', 'manual')).toBe('Northbridge Agent Platform (simulated) (auto)')
    expect(text(null, 'api')).toBe('API')
    expect(text(null, 'manual')).toBe('Manual')
    expect(text(null, 'discovered')).toBe('Found unregistered')
  })
})
