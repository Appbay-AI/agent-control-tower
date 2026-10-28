import type { Page } from '@playwright/test'

/**
 * Starts watching, inside the page, for an approval card containing `text`, and records the exact moment it first
 * appears (Date.now() in the browser, the same clock as the test runner on this machine).
 *
 * Why: Playwright's `expect(...).toBeVisible()` re-checks at growing intervals (0.1 s, 0.25 s, 0.5 s, then every
 * second), so the time it reports can be up to a second later than when the card really appeared. The live-list
 * target (task 2.5: on screen within 2 seconds) is measured with this instead.
 */
export async function watchForCard(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const w = window as unknown as { __actSeen?: Record<string, number> }
    w.__actSeen ??= {}
    const has = () => [...document.querySelectorAll('[data-testid="request-card"]')].some((e) => e.textContent?.includes(t))
    if (has()) { w.__actSeen[t] = Date.now(); return }
    const obs = new MutationObserver(() => {
      if (has()) { w.__actSeen![t] = Date.now(); obs.disconnect() }
    })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  }, text)
}

/** When the card with `text` first appeared (browser clock), or null if it has not. */
export async function cardSeenAt(page: Page, text: string): Promise<number | null> {
  return page.evaluate((t) => (window as unknown as { __actSeen?: Record<string, number> }).__actSeen?.[t] ?? null, text)
}

/**
 * Where the time went between `raisedAt` (runner clock) and the card appearing: the Realtime message reaching the
 * browser, the list being read again, and the screen being updated. Uses the app's performance marks (src/lib/live.tsx).
 */
export async function liveBreakdown(page: Page, text: string, raisedAt: number): Promise<string> {
  const t = await page.evaluate((x) => {
    const at = (n: string) => performance.getEntriesByName(n).map((e) => performance.timeOrigin + e.startTime)
    return { events: at('act:live-event'), loads: at('act:live-loaded'),
      seen: (window as unknown as { __actSeen?: Record<string, number> }).__actSeen?.[x] ?? null }
  }, text)
  if (t.seen === null) return 'card not seen'
  const event = t.events.find((e) => e >= raisedAt - 1000 && e <= t.seen!)
  const load = t.loads.filter((l) => l <= t.seen! + 5).pop()
  const ms = (a?: number, b?: number) => (a !== undefined && b !== undefined ? `${Math.round(b - a)} ms` : '?')
  return `realtime message ${ms(raisedAt, event)}, list re-read ${ms(event, load)}, screen ${ms(load, t.seen)}`
}
