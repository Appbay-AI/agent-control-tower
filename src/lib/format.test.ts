import { formatDate, formatMoney, isReviewOverdue, parseList } from '@/lib/format'

describe('format helpers', () => {
  it('turns free text into a clean list', () => {
    expect(parseList(' SAP, Salesforce\n\nSAP \n Workday ')).toEqual(['SAP', 'Salesforce', 'Workday'])
    expect(parseList('')).toEqual([])
  })

  it('shows dates the British way and blanks as a dash', () => {
    expect(formatDate('2026-10-06')).toBe('6 Oct 2026')
    expect(formatDate(null)).toBe('—')
  })

  it('formats limits as money', () => {
    expect(formatMoney(2000000, 'GBP')).toBe('£2,000,000')
    expect(formatMoney(null)).toBe('—')
  })

  it('treats a review as overdue only for live agents past their date', () => {
    const now = new Date('2026-10-06T10:00:00Z')
    expect(isReviewOverdue('2026-10-05', 'live', now)).toBe(true)
    expect(isReviewOverdue('2026-10-06', 'live', now)).toBe(false)
    expect(isReviewOverdue('2026-10-05', 'approved', now)).toBe(false)
    expect(isReviewOverdue(null, 'live', now)).toBe(false)
  })
})
