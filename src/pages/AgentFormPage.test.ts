import { emptyDraft, validateDraft } from '@/pages/AgentFormPage'

describe('registration form checks', () => {
  it('needs a name', () => {
    expect(validateDraft({ ...emptyDraft('u'), name: ' ' })).toMatch(/name/)
  })
  it('needs a vendor name for vendor agents', () => {
    expect(validateDraft({ ...emptyDraft('u'), name: 'x', origin: 'vendor' })).toMatch(/vendor/)
  })
  it('needs a limit for Level 3', () => {
    const d = { ...emptyDraft('u'), name: 'x', autonomy_level: 3 as const }
    expect(validateDraft(d)).toMatch(/Level 3/)
    expect(validateDraft({ ...d, volume_threshold: 50 })).toBeNull()
  })
})
