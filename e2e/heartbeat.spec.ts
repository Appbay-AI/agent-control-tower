import { expect, test, type Page } from '@playwright/test'

// Task 2.11: the log API and the silent-agent check, end to end. The admin watches the Regulatory Change Summariser
// (flag if silent for more than 1 minute) and gives it a key; the "agent" writes to its log and checks in through the
// public API; the page shows both. Then the agent goes quiet: within about two minutes it is flagged as silent. It
// checks in again and the flag clears at once. Afterwards: not watched, key revoked. The e2e workflow tidies up too.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const AGENT = 'Regulatory Change Summariser'

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

async function setLimit(page: Page, label: string) {
  const checkins = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Check-ins' }) })
  await checkins.getByLabel('Flag if silent for more than').selectOption({ label })
  await checkins.getByRole('button', { name: 'Save' }).click()
}

test('an agent writes to its log and checks in; when it goes quiet it is flagged as silent, and cleared when heard from', async ({ page, request }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(6 * 60_000)
  const stamp = `E2E ${Date.now()}`

  await signIn(page, 'admin')
  await page.getByLabel('Search agents').fill(AGENT)
  await page.getByRole('link', { name: AGENT }).first().click()
  await expect(page.getByRole('heading', { name: AGENT })).toBeVisible()
  const agentId = page.url().split('/').pop()!
  const code = (await page.getByTestId('agent-code').textContent())!.trim()
  expect(code).toMatch(/^AGT-\d{4}$/)

  let keyPrefix = ''
  try {
    // The admin watches it and makes it a key.
    await setLimit(page, 'Silent for more than 1 minute')
    await expect(page.getByTestId('silence-limit')).toHaveText('Flag if silent for more than 1 minute')
    await page.getByRole('button', { name: 'New key' }).click()
    const key = (await page.getByRole('dialog').locator('code').textContent())!.trim()
    keyPrefix = key.slice(0, 16) // as shown in the key list
    await page.getByRole('button', { name: 'Done' }).click()
    const auth = { authorization: `Bearer ${key}` }

    // The agent writes to its log (by code in the address) and checks in (by id).
    const logged = await request.post(`/api/v1/agents/${code}/logs`, {
      headers: auth,
      data: { entries: [
        { level: 'info', event: 'e2e.started', message: `Summarising new rules ${stamp}`, details: { source: 'e2e' }, id: `${stamp}-1` },
        { level: 'warning', message: `One source was slow ${stamp}`, id: `${stamp}-2` },
      ] },
    })
    expect(logged.status()).toBe(201)
    expect(await logged.json()).toMatchObject({ accepted: 2, duplicates: 0, may_act: true })
    const again = await request.post(`/api/v1/agents/${code}/logs`, { headers: auth, data: { message: 'retry', id: `${stamp}-1` } })
    expect(await again.json()).toMatchObject({ accepted: 0, duplicates: 1 })
    const bad = await request.post(`/api/v1/agents/${code}/logs`, { headers: auth, data: [{ message: 'ok' }, { level: 'loud', message: 'x' }] })
    expect(bad.status()).toBe(422)
    expect((await bad.json()).message).toContain('Entry 2: level must be')
    const other = await request.post(`/api/v1/agents/${code === 'AGT-0001' ? 'AGT-0002' : 'AGT-0001'}/heartbeat`, { headers: auth })
    expect(other.status()).toBe(403)

    const beat = await request.post(`/api/v1/agents/${agentId}/heartbeat`, { headers: auth, data: { note: `All quiet ${stamp}` } })
    expect(beat.status()).toBe(200)
    const b = await beat.json()
    expect(b).toMatchObject({ agent_code: code, status: 'live', may_act: true, silent_after_minutes: 1 })
    expect(new Date(b.check_in_by).getTime() - new Date(b.heard_at).getTime()).toBe(60_000)
    const lastBeat = Date.now()

    // The page shows the check-in and the log.
    await page.reload()
    await expect(page.getByTestId('last-heard')).toContainText('check-in')
    await expect(page.getByText(`Last check-in: “All quiet ${stamp}”`)).toBeVisible()
    await expect(page.getByTestId('watch-state')).toContainText('Next check-in due within')
    const entries = page.getByTestId('log-entry')
    await expect(entries.filter({ hasText: `Summarising new rules ${stamp}` })).toContainText('e2e.started')
    await expect(entries.filter({ hasText: `One source was slow ${stamp}` })).toContainText('Warning')
    await expect(page.getByTestId('alert-agent_silent')).toHaveCount(0) // checked after the page has loaded (above)

    // The agent goes quiet. Within about two minutes (1-minute limit, checked every minute) it is flagged.
    await expect.poll(async () => {
      await page.reload()
      await expect(page.getByTestId('last-heard')).toBeVisible() // the page has loaded its data
      return page.getByTestId('alert-agent_silent').count()
    }, { timeout: 170_000, intervals: [10_000] }).toBe(1)
    const after = Math.round((Date.now() - lastBeat) / 1000)
    console.log(`[heartbeat] silent flag after ${after} s`)
    info.annotations.push({ type: 'silent flag after', description: `${after} s` })
    await expect(page.getByTestId('alert-agent_silent')).toContainText(`${code} has gone silent: nothing heard from it for more than 1 minute`)
    await expect(page.getByTestId('watch-state')).toContainText('Silent: nothing heard for more than 1 minute')
    // ...and on the registry.
    await page.goto('/agents')
    await page.getByRole('button', { name: /Silent/ }).click()
    await expect(page.getByRole('link', { name: AGENT }).first()).toBeVisible()

    // It checks in: the flag clears at once.
    expect((await request.post(`/api/v1/agents/${agentId}/heartbeat`, { headers: auth })).status()).toBe(200)
    await page.goto(`/agents/${agentId}`)
    await expect(page.getByTestId('last-heard')).toContainText('Just now')
    await expect(page.getByTestId('alert-agent_silent')).toHaveCount(0)
  } finally {
    // Tidy up: stop watching, revoke the key.
    await page.goto(`/agents/${agentId}`)
    if (!(await page.getByTestId('silence-limit').textContent())?.includes('Not watched')) {
      await setLimit(page, 'Not watched')
      await expect(page.getByTestId('silence-limit')).toHaveText('Not watched')
    }
    if (keyPrefix) {
      const row = page.locator('li').filter({ hasText: `${keyPrefix}…` })
      await row.getByRole('button', { name: 'Revoke' }).click()
      await expect(row.getByText('revoked')).toBeVisible()
    }
  }
})
