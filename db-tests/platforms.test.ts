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
