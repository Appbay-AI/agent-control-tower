import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createUser } from './harness'

// Task 3.2: platform connections and the jobs our API runs on them ("Test connection").
describe('platform connections (task 3.2)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let conn: string
  const SITE = 'https://main.agent-control-tower-56p.pages.dev'
  const APPIAN = 'https://appbay-demo.appiancloud.com'

  beforeAll(async () => {
    db = await createDb()
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await db.query(`select public.push_configure($1)`, [SITE])
    const r = await db.query<{ r: string }>(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', $1, 'key-1') r`, [`${APPIAN}/`])
    expect(r.rows[0].r).toBe('created, secret stored')
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  const start = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ id: number }>(`select public.platform_job_start($1) id`, [conn])).rows[0].id)
  /** The token pg_net was asked to post for the latest job. */
  const lastToken = async () => (await db.query<{ url: string; token: string }>(
    `select url, body ->> 'token' token from net.calls order by id desc limit 1`)).rows[0]
  const claim = (token: string) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: Record<string, unknown> }>(`select public.platform_job_claim($1) r`, [token])).rows[0].r)
  const report = (token: string, ok: boolean, message: string, result: unknown = null) => asRole(db, 'anon', (tx) =>
    tx.query(`select public.platform_job_report($1, $2, $3, $4::jsonb)`, [token, ok, message, result === null ? null : JSON.stringify(result)]))
  const job = async (id: number) => (await db.query<{ ok: boolean | null; message: string | null; finished_at: string | null; result: unknown }>(
    `select ok, message, finished_at, result from public.platform_jobs where id = $1`, [id])).rows[0]

  it('stores the connection, keeps the address tidy, and records secret changes without the secret', async () => {
    expect((await db.query<{ base_url: string }>(`select base_url from public.platform_connections`)).rows[0].base_url).toBe(APPIAN)
    expect((await db.query<{ r: string }>(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', $1, 'key-1') r`, [APPIAN])).rows[0].r)
      .toBe('unchanged')
    expect((await db.query<{ r: string }>(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', $1, 'key-2') r`, [APPIAN])).rows[0].r)
      .toBe('unchanged, secret stored')
    const audit = await db.query<{ action: string; after: string }>(
      `select action, after::text from public.audit_events where entity_type = 'platform_connections' order by seq`)
    // Created; first secret stored; secret changed. The unchanged run adds nothing.
    expect(audit.rows.map((r) => r.action)).toEqual(['platform_connections.insert', 'platform_connections.update', 'platform_connections.update'])
    expect(audit.rows.map((r) => r.after).join()).not.toContain('key-')
    await expect(db.query(`select public.platform_configure('appian_simulator', 'Other', 'http://plain.example.com', 'k')`)).rejects.toThrow()
    await expect(db.query(`select public.platform_configure('microsoft', 'Other', 'https://x.example.com', 'k')`)).rejects.toThrow()
  })

  it('lets only admins see connections and jobs, and nobody see the secret or tokens', async () => {
    const seen = (who: string) => asUser(db, who, async (tx) => (await tx.query(`select * from public.platform_connections`)).rows.length)
    expect(await seen(u.admin)).toBe(1)
    expect(await seen(u.ravi)).toBe(0)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select * from public.platform_secrets`))).rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select token_hash from public.platform_jobs`))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.platform_connections`))).rejects.toThrow(/permission denied/)
    await expect(start(u.ravi)).rejects.toThrow(/Only admins/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.platform_configure('appian_simulator', 'X', 'https://x.example.com', 'k')`)))
      .rejects.toThrow(/permission denied/)
  })

  it('an admin starts a check; our API claims it once with the secret and reports back', async () => {
    const id = await start(u.admin)
    expect(await start(u.admin)).toBe(id) // pressed twice: still one job
    const call = await lastToken()
    expect(call.url).toBe(`${SITE}/api/v1/platforms/run`)
    expect(call.token).toMatch(/^pjt_[0-9a-f]{64}$/)

    const claimed = await claim(call.token)
    expect(claimed).toMatchObject({ job: id, kind: 'check',
      connection: { id: conn, kind: 'appian_simulator', base_url: APPIAN, secret: 'key-2', name: 'Northbridge Agent Platform (simulated)' } })
    await expect(claim(call.token)).rejects.toThrow(/Invalid or used job token/)

    await report(call.token, true, 'Connected: 8 agents', { agents: 8, blocked: 1 })
    expect(await job(id)).toMatchObject({ ok: true, message: 'Connected: 8 agents', result: { agents: 8, blocked: 1 } })
    await expect(report(call.token, false, 'again')).rejects.toThrow(/Invalid or used job token/)
    // The admin sees the result; the next press starts a new job.
    const shown = await asUser(db, u.admin, async (tx) => (await tx.query<{ ok: boolean; message: string }>(
      `select ok, message from public.platform_jobs where id = $1`, [id])).rows[0])
    expect(shown).toEqual({ ok: true, message: 'Connected: 8 agents' })
    expect(await start(u.admin)).not.toBe(id)
  })

  it('refuses wrong, unclaimed and stale tokens', async () => {
    await expect(claim('pjt_' + '0'.repeat(64))).rejects.toThrow(/Invalid or used job token/)
    await db.query(`update public.platform_jobs set finished_at = now(), ok = false where finished_at is null`)
    const id = await start(u.admin)
    const { token } = await lastToken()
    await expect(report(token, true, 'never claimed')).rejects.toThrow(/Invalid or used job token/)
    await db.query(`update public.platform_jobs set created_at = now() - interval '11 minutes' where id = $1`, [id])
    await expect(claim(token)).rejects.toThrow(/Invalid or used job token/)
  })

  it('marks a job the site never answered as failed after two minutes', async () => {
    const old = (await db.query<{ id: number }>(`select id from public.platform_jobs where finished_at is null order by id desc limit 1`)).rows[0].id
    await db.query(`update public.platform_jobs set created_at = now() - interval '3 minutes' where id = $1`, [old])
    const fresh = await start(u.admin)
    expect(fresh).not.toBe(old)
    expect(await job(old)).toMatchObject({ ok: false, message: 'Our site did not pick up the job within 2 minutes.' })
  })

  it('fails at once, with a reason, when the database does not know its site', async () => {
    await db.query(`update public.platform_jobs set finished_at = now(), ok = false where finished_at is null`)
    await db.query(`update public.push_config set site_url = null`)
    const id = await start(u.admin)
    expect(await job(id)).toMatchObject({ ok: false, message: expect.stringContaining('does not know its site address') })
    await db.query(`select public.push_configure($1)`, [SITE])
  })
})

// Task 3.3: fetching agents on a schedule and with "Sync now".
describe('platform sync (task 3.3)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let conn: string
  const SITE = 'https://main.agent-control-tower-56p.pages.dev'

  beforeAll(async () => {
    db = await createDb()
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.auditor = await createUser(db, 'audit@bank.test', ['auditor'], 'Ann Auditor')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await db.query(`select public.push_configure($1)`, [SITE])
    await db.query(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', 'https://appbay-demo.appiancloud.com', 'key-1')`)
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  const agent = (id: string, status = 'active', extra: Record<string, unknown> = {}) => ({
    externalId: id, name: `Agent ${id}`, status, owner: id === 'NAP-004' ? null : { email: 'lucy.grant@northbridge.demo', name: 'Lucy Grant' },
    department: 'Customer Service', environment: 'Production', dataSources: [], tools: [], dataClassifications: [], sharedWith: [], ...extra,
  })
  const syncNow = (who = u.admin) => asUser(db, who, async (tx) => (await tx.query<{ id: number }>(`select public.platform_job_start($1, 'sync') id`, [conn])).rows[0].id)
  const lastToken = async () => (await db.query<{ token: string }>(`select body ->> 'token' token from net.calls order by id desc limit 1`)).rows[0].token
  /** Our API's side: claim the job, store the agents, report. */
  async function run(agents: unknown[]) {
    const token = await lastToken()
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_claim($1)`, [token]))
    const out = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: Record<string, number> }>(
      `select public.platform_sync_apply($1, $2::jsonb) r`, [token, JSON.stringify(agents)])).rows[0].r)
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_report($1, true, 'Synced', $2::jsonb)`, [token, JSON.stringify(out)]))
    return out
  }
  const stored = async () => (await db.query<{ external_id: string; status: string; missing: boolean; owner_email: string | null }>(
    `select external_id, status, missing_since is not null missing, owner_email from public.platform_agents order by external_id`)).rows
  const audit = async () => (await db.query<{ action: string; summary: string }>(
    `select action, summary from public.audit_events where entity_type = 'platform_agents' order by seq`)).rows

  it('Sync now stores every agent the platform listed, and records each new one in the audit trail', async () => {
    await syncNow()
    expect(await run([agent('NAP-001'), agent('NAP-004'), agent('NAP-007', 'blocked')]))
      .toEqual({ agents: 3, new: 3, status_changed: 0, back: 0, missing: 0, blocked: 1 })
    expect(await stored()).toEqual([
      { external_id: 'NAP-001', status: 'active', missing: false, owner_email: 'lucy.grant@northbridge.demo' },
      { external_id: 'NAP-004', status: 'active', missing: false, owner_email: null },
      { external_id: 'NAP-007', status: 'blocked', missing: false, owner_email: 'lucy.grant@northbridge.demo' },
    ])
    expect((await audit()).map((a) => a.summary)).toEqual([
      'NAP-001 Agent NAP-001 found on Northbridge Agent Platform (simulated)',
      'NAP-004 Agent NAP-004 found on Northbridge Agent Platform (simulated) (no owner)',
      'NAP-007 Agent NAP-007 found on Northbridge Agent Platform (simulated) (blocked there)',
    ])
  })

  it('the next sync notices new, changed, missing and returning agents', async () => {
    await syncNow()
    expect(await run([agent('NAP-001', 'blocked', { statusChangedBy: 'appian.admin' }), agent('NAP-007', 'blocked'), agent('NAP-009')]))
      .toEqual({ agents: 3, new: 1, status_changed: 1, back: 0, missing: 1, blocked: 2 })
    expect((await stored()).find((a) => a.external_id === 'NAP-004')).toMatchObject({ missing: true })
    await syncNow()
    expect(await run([agent('NAP-001'), agent('NAP-004'), agent('NAP-007', 'blocked'), agent('NAP-009')]))
      .toEqual({ agents: 4, new: 0, status_changed: 1, back: 1, missing: 0, blocked: 1 })
    expect((await audit()).slice(3).map((a) => [a.action, a.summary])).toEqual([
      ['platform_agents.status_changed', 'NAP-001 Agent NAP-001 is blocked on Northbridge Agent Platform (simulated) (was active) by appian.admin'],
      ['platform_agents.discovered', 'NAP-009 Agent NAP-009 found on Northbridge Agent Platform (simulated)'],
      ['platform_agents.missing', 'NAP-004 Agent NAP-004 is no longer listed on Northbridge Agent Platform (simulated)'],
      ['platform_agents.status_changed', 'NAP-001 Agent NAP-001 is active on Northbridge Agent Platform (simulated) (was blocked)'],
      ['platform_agents.back', 'NAP-004 Agent NAP-004 is listed on Northbridge Agent Platform (simulated) again'],
    ])
    expect((await db.query<{ broken: number }>(`select count(*)::int broken from public.audit_verify_chain()`)).rows[0].broken).toBe(0)
  })

  it('refuses bad lists, the wrong kind of job, and a used token', async () => {
    await syncNow()
    const token = await lastToken()
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_claim($1)`, [token]))
    const apply = (agents: unknown) => asRole(db, 'anon', (tx) => tx.query(`select public.platform_sync_apply($1, $2::jsonb)`, [token, JSON.stringify(agents)]))
    await expect(apply({ agents: [] })).rejects.toThrow(/must be a list/)
    await expect(apply([agent('NAP-001', 'paused')])).rejects.toThrow(/status of active or blocked/)
    await expect(apply([agent('NAP-001'), agent('NAP-001')])).rejects.toThrow(/listed twice/)
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_report($1, false, 'Failed')`, [token]))
    await expect(apply([agent('NAP-001')])).rejects.toThrow(/Invalid or used job token/)
    // A "Test connection" job cannot store agents.
    await asUser(db, u.admin, (tx) => tx.query(`select public.platform_job_start($1, 'check')`, [conn]))
    const check = await lastToken()
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_claim($1)`, [check]))
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.platform_sync_apply($1, '[]'::jsonb)`, [check]))).rejects.toThrow(/Invalid or used job token/)
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_report($1, true, 'ok')`, [check]))
  })

  it('the clock syncs each connection when its interval (30 minutes by default) has passed', async () => {
    const due = async () => (await db.query<{ n: number }>(`select public.platform_sync_due() n`)).rows[0].n
    expect((await db.query<{ m: number }>(`select sync_every_minutes m from public.platform_connections`)).rows[0].m).toBe(30)
    expect(await due()).toBe(0) // synced moments ago
    await db.query(`update public.platform_jobs set created_at = created_at - interval '29 minutes 30 seconds' where kind = 'sync'`)
    const before = (await db.query<{ n: number }>(`select count(*)::int n from public.platform_jobs where kind = 'sync'`)).rows[0].n
    expect(await due()).toBe(1) // within the minute's grace
    expect(await due()).toBe(0) // still running: not started twice
    expect((await db.query<{ n: number; by: string | null }>(
      `select count(*)::int n, max(requested_by::text) by from public.platform_jobs where kind = 'sync' and created_at > now() - interval '1 minute'`)).rows[0])
      .toEqual({ n: 1, by: null })
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.platform_jobs where kind = 'sync'`)).rows[0].n).toBe(before + 1)
  })

  it('admins change the interval or turn it off (audited); others cannot', async () => {
    const set = (who: string, m: number | null) => asUser(db, who, (tx) => tx.query(`select public.set_platform_sync_interval($1, $2)`, [conn, m]))
    await expect(set(u.ravi, 60)).rejects.toThrow(/Only admins/)
    await expect(set(u.admin, 2)).rejects.toThrow(/between 5 minutes and 1 day/)
    await set(u.admin, 60)
    await set(u.admin, null)
    await db.query(`update public.platform_jobs set created_at = created_at - interval '1 day'`)
    expect((await db.query<{ n: number }>(`select public.platform_sync_due() n`)).rows[0].n).toBe(0) // off
    expect((await db.query<{ reason: string }>(
      `select reason from public.audit_events where entity_type = 'platform_connections' order by seq desc limit 2`)).rows.map((r) => r.reason))
      .toEqual(['Automatic sync turned off', 'Sync every 60 minutes'])
    await set(u.admin, 30)
  })

  it('admins, executives and auditors see platform agents; approvers do not', async () => {
    const seen = (who: string) => asUser(db, who, async (tx) => (await tx.query(`select external_id from public.platform_agents`)).rows.length)
    expect(await seen(u.admin)).toBe(4)
    expect(await seen(u.auditor)).toBe(4)
    expect(await seen(u.ravi)).toBe(0)
    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.platform_job_start($1, 'sync')`, [conn]))).rejects.toThrow(/Only admins/)
  })
})
