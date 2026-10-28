import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 2.11: the agent log API and the silent-agent (heartbeat) check.
describe('agent log and silent-agent check (task 2.11)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let ops: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    ops = await createDepartment(db, 'Operations')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    await grantScope(db, u.ravi, payments)
    await grantScope(db, u.omar, ops)
  })

  async function liveAgent() {
    const id = await proposeAgent(db, u.owner, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments,
      autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, u.owner, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    owners.set(key, id)
    return { id, key }
  }

  type LogAnswer = { accepted: number; duplicates: number; may_act: boolean }
  /** The agent each key belongs to, as the API path names it. */
  const owners = new Map<string, string>()
  const log = (key: string, entries: unknown, agent = owners.get(key) ?? null) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: LogAnswer }>(`select public.api_agent_log($1, $2, $3::jsonb) r`, [key, agent, JSON.stringify(entries)])).rows[0].r)
  type Beat = { agent_code: string; status: string; may_act: boolean; heard_at: string; silent_after_minutes: number | null; check_in_by: string | null }
  const beat = (key: string, note: string | null = null, agent = owners.get(key) ?? null) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: Beat }>(`select public.api_agent_heartbeat($1, $2, $3) r`, [key, agent, note])).rows[0].r)
  const setLimit = (who: string, agent: string, minutes: number | null) =>
    asUser(db, who, (tx) => tx.query(`select public.set_agent_silence_limit($1, $2)`, [agent, minutes]))
  const contact = async (agent: string) => (await db.query<{ last_seen_via: string | null; last_note: string | null; last_seen_at: string | null }>(
    `select last_seen_via, last_note, last_seen_at from public.agent_contact where agent_id = $1`, [agent])).rows[0]
  const openSilent = async (agent: string) => (await db.query<{ message: string }>(
    `select message from public.alerts where agent_id = $1 and kind = 'agent_silent' and resolved_at is null`, [agent])).rows
  /** Pretends the agent was last heard from (and watched since) this many minutes ago. */
  const quietFor = (agent: string, minutes: number) => db.query(
    `update public.agent_contact set last_seen_at = now() - make_interval(mins => $2), watch_from = now() - make_interval(mins => $2 + 60)
      where agent_id = $1`, [agent, minutes])
  const check = async () => (await db.query<{ n: number }>(`select public.check_silent_agents() n`)).rows[0].n

  it('stores log entries from the agent, one or many, linked to its own requests', async () => {
    const { id, key } = await liveAgent()
    expect(await log(key, { message: 'Started the morning run' })).toMatchObject({ accepted: 1, duplicates: 0, may_act: true })
    const asked = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { request_code: string } }>(
      `select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({ idempotency_key: 'k1', action: 'payment.release', amount: 2_000_000, currency: 'GBP' })])).rows[0].r)
    expect(await log(key, [
      { level: 'warning', event: 'limit.exceeded', message: 'Above my £250k limit; asked for approval', request: asked.request_code,
        details: { invoice: 'HS-48817' }, id: 'run-1-step-2', occurred_at: new Date(Date.now() - 60_000).toISOString() },
      { level: 'ERROR', message: 'Bank gateway timed out; will retry' },
    ])).toMatchObject({ accepted: 2 })
    const rows = (await db.query<{ level: string; event: string | null; message: string; linked: boolean; details: unknown; has_key: boolean }>(
      `select level, event, message, request_id is not null linked, details, api_key_id is not null has_key
         from public.agent_logs where agent_id = $1 order by id`, [id])).rows
    expect(rows).toEqual([
      { level: 'info', event: null, message: 'Started the morning run', linked: false, details: null, has_key: true },
      { level: 'warning', event: 'limit.exceeded', message: 'Above my £250k limit; asked for approval', linked: true, details: { invoice: 'HS-48817' }, has_key: true },
      { level: 'error', event: null, message: 'Bank gateway timed out; will retry', linked: false, details: null, has_key: true },
    ])
    // Sending an entry again with the same id is ignored, so agents can retry safely.
    expect(await log(key, [{ id: 'run-1-step-2', message: 'again' }, { message: 'new one' }])).toMatchObject({ accepted: 1, duplicates: 1 })
    expect(await contact(id)).toMatchObject({ last_seen_via: 'log entry' })
    // The path may name the agent by its code; another agent's id or code is refused before anything is stored.
    const code = (await db.query<{ c: string }>(`select agent_code c from public.agents where id = $1`, [id])).rows[0].c
    expect(await log(key, { message: 'by code' }, code.toLowerCase())).toMatchObject({ accepted: 1 })
    const other = await liveAgent()
    await expect(log(key, { message: 'not mine' }, other.id)).rejects.toThrow(/belongs to a different agent/)
    await expect(beat(key, null, other.id)).rejects.toThrow(/belongs to a different agent/)
    expect((await db.query(`select 1 from public.agent_logs where message = 'not mine'`)).rows).toHaveLength(0)
  })

  it('refuses a bad batch as a whole, saying which entry is wrong', async () => {
    const { id, key } = await liveAgent()
    const other = await liveAgent()
    const otherReq = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { request_code: string } }>(
      `select public.api_request_action($1, $2::jsonb) r`, [other.key, JSON.stringify({ idempotency_key: 'x', action: 'payment.release', amount: 5, currency: 'GBP' })])).rows[0].r)
    const cases: [unknown, RegExp][] = [
      [[], /at least one/],
      [[{ message: 'ok' }, { level: 'loud', message: 'x' }], /Entry 2: level must be/],
      [[{ message: '  ' }], /Entry 1: message is required/],
      [[{ message: 'x'.repeat(2001) }], /2,000 characters/],
      [[{ message: 'x', event: 'has spaces' }], /event must be a short code/],
      [[{ message: 'x', occurred_at: 'yesterday-ish' }], /occurred_at must be a date/],
      [[{ message: 'x', occurred_at: '2020-01-01T00:00:00Z' }], /within the last 7 days/],
      [[{ message: 'x', details: [1, 2] }], /details must be a JSON object/],
      [[{ message: 'x', details: { big: 'y'.repeat(9000) } }], /8 KB/],
      [[{ message: 'x', request: otherReq.request_code }], /is not one of this agent's requests/],
      [Array.from({ length: 101 }, () => ({ message: 'x' })), /at most 100/],
    ]
    for (const [entries, err] of cases) await expect(log(key, entries)).rejects.toThrow(err)
    expect((await db.query(`select 1 from public.agent_logs where agent_id = $1`, [id])).rows).toHaveLength(0)
    await expect(log('act_not_a_real_key', [{ message: 'x' }])).rejects.toThrow(/Invalid or revoked agent key/)
  })

  it('shows logs only to people who can see the agent, and nobody can change or delete them', async () => {
    const { id, key } = await liveAgent()
    await log(key, { message: 'Secret-free but private to Payments' })
    const seen = (who: string) => asUser(db, who, async (tx) => (await tx.query(`select message from public.agent_logs where agent_id = $1`, [id])).rows)
    expect(await seen(u.ravi)).toHaveLength(1)
    expect(await seen(u.owner)).toHaveLength(1)
    expect(await seen(u.omar)).toHaveLength(0)
    await expect(asUser(db, u.admin, (tx) => tx.query(`insert into public.agent_logs (agent_id, level, message, occurred_at) values ($1, 'info', 'forged', now())`, [id])))
      .rejects.toThrow(/permission denied/)
    await expect(db.query(`update public.agent_logs set message = 'rewritten' where agent_id = $1`, [id])).rejects.toThrow(/cannot be changed/)
    await expect(db.query(`delete from public.agent_logs where agent_id = $1`, [id])).rejects.toThrow(/cannot be deleted/)
    // Deleting the key only clears the link.
    await db.query(`delete from public.agent_api_keys where agent_id = $1`, [id])
    expect((await db.query<{ k: string | null }>(`select api_key_id k from public.agent_logs where agent_id = $1`, [id])).rows[0].k).toBeNull()
  })

  it('a check-in says whether the agent may act and by when to check in next', async () => {
    const { id, key } = await liveAgent()
    expect(await beat(key, 'Queue: 12 invoices')).toMatchObject({ status: 'live', may_act: true, silent_after_minutes: null, check_in_by: null })
    expect(await contact(id)).toMatchObject({ last_seen_via: 'check-in', last_note: 'Queue: 12 invoices' })
    await setLimit(u.owner, id, 15)
    const b = await beat(key)
    expect(b.silent_after_minutes).toBe(15)
    expect(new Date(b.check_in_by!).getTime() - new Date(b.heard_at).getTime()).toBe(15 * 60_000)
    await expect(beat(key, 'x'.repeat(501))).rejects.toThrow(/500 characters/)
    // A suspended agent can still check in, and is told not to act.
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'suspended' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    expect(await beat(key)).toMatchObject({ status: 'suspended', may_act: false })
  })

  it('every call with the key counts as being heard from: status checks and action requests too', async () => {
    const { id, key } = await liveAgent()
    await asRole(db, 'anon', (tx) => tx.query(`select public.api_agent_status($1)`, [key]))
    expect(await contact(id)).toMatchObject({ last_seen_via: 'status check' })
    await asRole(db, 'anon', (tx) => tx.query(`select public.api_request_action($1, $2::jsonb)`,
      [key, JSON.stringify({ idempotency_key: 'k', action: 'invoice.match' })]))
    expect(await contact(id)).toMatchObject({ last_seen_via: 'API call' })
  })

  it('only admins and the agent\'s owners can set the limit; it is audited with the reason', async () => {
    const { id } = await liveAgent()
    await expect(setLimit(u.ravi, id, 10)).rejects.toThrow(/Only admins and the agent's owners/)
    await expect(setLimit(u.owner, id, 0)).rejects.toThrow(/between 1 minute and 7 days/)
    await setLimit(u.admin, id, 60)
    const audit = (await db.query<{ reason: string; actor_id: string }>(
      `select reason, actor_id from public.audit_events where action = 'agents.update' and entity_id = $1 order by seq desc limit 1`, [id])).rows[0]
    expect(audit).toEqual({ reason: 'Flag if silent for more than 1 hour', actor_id: u.admin })
  })

  it('flags a live, watched agent that has gone quiet, and clears the flag the moment it is heard from', async () => {
    const { id, key } = await liveAgent()
    const code = (await db.query<{ c: string }>(`select agent_code c from public.agents where id = $1`, [id])).rows[0].c
    await setLimit(u.owner, id, 15)
    await beat(key)
    await check()
    expect(await openSilent(id)).toEqual([]) // just checked in
    await quietFor(id, 16)
    expect(await check()).toBeGreaterThanOrEqual(1)
    expect(await openSilent(id)).toEqual([{ message: `${code} has gone silent: nothing heard from it for more than 15 minutes` }])
    expect(await check()).toBe(0) // flagged once
    // Visible like the other alerts, to people who can see the agent.
    expect(await asUser(db, u.ravi, async (tx) => (await tx.query(`select 1 from public.alerts where agent_id = $1 and kind = 'agent_silent'`, [id])).rows)).toHaveLength(1)
    expect(await asUser(db, u.omar, async (tx) => (await tx.query(`select 1 from public.alerts where agent_id = $1`, [id])).rows)).toHaveLength(0)

    await log(key, { message: 'Back after a restart' })
    expect(await openSilent(id)).toEqual([])
    const cleared = (await db.query<{ actor_type: string; reason: string }>(
      `select actor_type, reason from public.audit_events where action = 'alerts.update' and agent_id = $1 order by seq desc limit 1`, [id])).rows[0]
    expect(cleared).toEqual({ actor_type: 'agent', reason: 'The agent was heard from again (log entry)' })
    const raised = (await db.query<{ actor_type: string }>(`select actor_type from public.audit_events where action = 'alerts.insert' and agent_id = $1`, [id])).rows
    expect(raised).toEqual([{ actor_type: 'system' }])
  })

  it('never flags an agent that is not watched or not live; stopping watching clears the flag', async () => {
    const unwatched = await liveAgent()
    await quietFor(unwatched.id, 100_000)
    const watched = await liveAgent()
    await setLimit(u.owner, watched.id, 5)
    await quietFor(watched.id, 10)
    await check()
    expect(await openSilent(unwatched.id)).toEqual([])
    expect(await openSilent(watched.id)).toHaveLength(1)
    await setLimit(u.owner, watched.id, null)
    expect(await openSilent(watched.id)).toEqual([])

    await setLimit(u.owner, watched.id, 5)
    await quietFor(watched.id, 10)
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'suspended' where id = $1`, [watched.id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await check()
    expect(await openSilent(watched.id)).toEqual([])
    // Live again: the clock restarts, so it is not flagged for the time it was suspended.
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'live' where id = $1`, [watched.id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await check()
    expect(await openSilent(watched.id)).toEqual([])
  })

  it('an agent never heard from is flagged once its limit has passed since watching started', async () => {
    const { id } = await liveAgent()
    await setLimit(u.owner, id, 5)
    await db.query(`update public.agent_contact set last_seen_at = null, watch_from = now() - interval '6 minutes' where agent_id = $1`, [id])
    await check()
    expect((await openSilent(id))[0].message).toMatch(/has not been heard from since it started being watched \(limit 5 minutes\)$/)
  })

  it('keeps logs 90 days', async () => {
    const { id, key } = await liveAgent()
    await log(key, [{ message: 'old' }, { message: 'recent' }])
    await db.query(`alter table public.agent_logs disable trigger agent_logs_guard`)
    await db.query(`update public.agent_logs set received_at = now() - interval '91 days' where agent_id = $1 and message = 'old'`, [id])
    await db.query(`alter table public.agent_logs enable trigger agent_logs_guard`)
    expect((await db.query<{ n: number }>(`select public.agent_logs_prune() n`)).rows[0].n).toBe(1)
    expect((await db.query<{ message: string }>(`select message from public.agent_logs where agent_id = $1`, [id])).rows).toEqual([{ message: 'recent' }])
  })

  it('locks the new functions down', async () => {
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.check_silent_agents()`))).rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.agent_logs_prune()`))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.record_agent_contact(gen_random_uuid(), 'x')`))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.set_agent_silence_limit(gen_random_uuid(), 5)`))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.agent_logs`))).rejects.toThrow(/permission denied/)
  })
})
