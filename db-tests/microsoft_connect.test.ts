import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createUser } from './harness'

// Task 3.1, resumed: "Connect Microsoft" (browser sign-in, renewable sign-in kept locked) and "Run Microsoft checks".
describe('Connect Microsoft (task 3.1)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const TENANT = '7535ea2c-3e9b-42b7-b942-d208757b8bb9'
  const CLIENT = '5d517613-a18d-4664-bc24-cd9c406c8669'

  beforeAll(async () => {
    db = await createDb()
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
  })

  const anon = <T>(sql: string, params: unknown[]) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0]?.r)
  const status = () => asUser(db, u.admin, async (tx) => (await tx.query<{ r: Record<string, unknown> }>(`select public.microsoft_status() r`)).rows[0].r)
  const start = () => asUser(db, u.admin, async (tx) => (await tx.query<{ r: Record<string, string> }>(`select public.microsoft_connect_start() r`)).rows[0].r)

  it('nothing to connect until the app registration and its secret are stored; only the workflow can store them', async () => {
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await expect(start()).rejects.toThrow(/app registration is not set up/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.microsoft_configure($1, $2, 'x')`, [TENANT, CLIENT])))
      .rejects.toThrow(/permission denied/)
    expect((await db.query<{ r: string }>(`select public.microsoft_configure($1, $2, '') r`, [TENANT, CLIENT])).rows[0].r).toBe('created, no secret yet')
    await expect(start()).rejects.toThrow(/client secret is not stored yet/)
    expect((await db.query<{ r: string }>(`select public.microsoft_configure($1, $2, 'shh') r`, [TENANT.toUpperCase(), CLIENT])).rows[0].r)
      .toBe('unchanged, secret stored')
    expect(await status()).toMatchObject({ app: true, tenant_id: TENANT, client_id: CLIENT, secret_set: true, connected: false,
      redirect_uri: 'https://main.example.pages.dev/api/v1/microsoft/callback' })
    expect(JSON.stringify(await status())).not.toContain('shh')
    // The locked tables are not readable, even by admins.
    await expect(asUser(db, u.admin, (tx) => tx.query(`select * from public.microsoft_app`))).rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.microsoft_status()`))).rejects.toThrow(/Only admins/)
  })

  it('sign-in: start gives the Microsoft address, PKCE challenge and state; our API swaps it once, then stores the sign-in', async () => {
    const s = await start()
    expect(s).toMatchObject({ authorize_url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`, client_id: CLIENT,
      redirect_uri: 'https://main.example.pages.dev/api/v1/microsoft/callback', code_challenge_method: 'S256',
      scope: 'https://api.powerplatform.com/.default offline_access openid profile' })
    expect(s.state).toMatch(/^mss_[0-9a-f]{64}$/)

    const claim = await anon<Record<string, string>>(`select public.microsoft_connect_claim($1) r`, [s.state])
    expect(claim).toMatchObject({ tenant_id: TENANT, client_id: CLIENT, client_secret: 'shh', redirect_uri: s.redirect_uri })
    // The challenge sent to Microsoft is SHA-256 of the verifier our API sends back (RFC 7636).
    expect(createHash('sha256').update(claim.code_verifier).digest('base64url')).toBe(s.code_challenge)
    await expect(anon(`select public.microsoft_connect_claim($1) r`, [s.state])).rejects.toThrow(/expired or was already used/)

    await anon(`select public.microsoft_connect_finish($1, 'rt-1', 'arpit@tenant.test', 'Arpit Khandelwal') r`, [s.state])
    expect(await status()).toMatchObject({ connected: true, account: 'arpit@tenant.test', account_name: 'Arpit Khandelwal', connected_by: 'Platform Admin' })
    await expect(anon(`select public.microsoft_connect_finish($1, 'rt-2', 'x', 'y') r`, [s.state])).rejects.toThrow(/Invalid or used/)
    expect((await db.query<{ t: string }>(`select refresh_token t from public.microsoft_connection`)).rows[0].t).toBe('rt-1')
    const audit = (await db.query<{ summary: string; actor_id: string }>(`select summary, actor_id from public.audit_events where action = 'microsoft_connection.connected'`)).rows
    expect(audit).toEqual([{ summary: 'Microsoft connected as arpit@tenant.test', actor_id: u.admin }])

    // A made-up state gets nothing; only our API (anon) may claim, not a signed-in user.
    await expect(anon(`select public.microsoft_connect_claim('mss_nope') r`, [])).rejects.toThrow(/expired or was already used/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.microsoft_connect_claim($1)`, [s.state]))).rejects.toThrow(/permission denied/)
  })

  it('a sign-in link older than 10 minutes cannot be used', async () => {
    const s = await start()
    await db.query(`update public.microsoft_signins set created_at = now() - interval '11 minutes' where state_hash = public.secret_hash($1)`, [s.state])
    await expect(anon(`select public.microsoft_connect_claim($1) r`, [s.state])).rejects.toThrow(/expired/)
  })

  it('run the checks: our API gets the sign-in once, reports results and keeps the newest renewable sign-in', async () => {
    const calls = (await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like '%/microsoft/run'`)).rows[0].n
    const id = await asUser(db, u.admin, async (tx) => (await tx.query<{ id: number }>(`select public.microsoft_check_start('Control Tower Test Agent') id`)).rows[0].id)
    expect(await asUser(db, u.admin, async (tx) => (await tx.query<{ id: number }>(`select public.microsoft_check_start(null) id`)).rows[0].id)).toBe(id) // no second run
    const call = (await db.query<{ url: string; token: string }>(`select url, body ->> 'token' token from net.calls where url like '%/microsoft/run' order by id desc limit 1`)).rows[0]
    expect((await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like '%/microsoft/run'`)).rows[0].n).toBe(calls + 1)
    expect(call.url).toBe('https://main.example.pages.dev/api/v1/microsoft/run')
    expect(call.token).toMatch(/^mct_[0-9a-f]{64}$/)

    const work = await anon<Record<string, unknown>>(`select public.microsoft_check_claim($1) r`, [call.token])
    expect(work).toMatchObject({ check: id, test_agent: 'Control Tower Test Agent', tenant_id: TENANT, client_secret: 'shh', refresh_token: 'rt-1' })
    await expect(anon(`select public.microsoft_check_claim($1) r`, [call.token])).rejects.toThrow(/Invalid or used/)
    const results = [{ id: 'C2', question: 'Can we block?', verdict: 'YES', detail: 'Read back as quarantined' }]
    await anon(`select public.microsoft_check_report($1, true, 'Checks finished', $2::jsonb, 'rt-2') r`, [call.token, JSON.stringify(results)])
    const row = (await asUser(db, u.admin, (tx) => tx.query<{ ok: boolean; message: string; results: unknown }>(
      `select ok, message, results from public.microsoft_checks where id = $1`, [id]))).rows[0]
    expect(row).toEqual({ ok: true, message: 'Checks finished', results })
    expect((await db.query<{ t: string }>(`select refresh_token t from public.microsoft_connection`)).rows[0].t).toBe('rt-2')
    // The token's hash is not readable; non-admins see no checks.
    await expect(asUser(db, u.admin, (tx) => tx.query(`select token_hash from public.microsoft_checks`))).rejects.toThrow(/permission denied/)
    expect((await asUser(db, u.ravi, (tx) => tx.query(`select id from public.microsoft_checks`))).rows).toHaveLength(0)
  })

  it('disconnect removes the sign-in and is on the record; checks then need a new sign-in', async () => {
    await asUser(db, u.admin, (tx) => tx.query(`select public.microsoft_disconnect()`))
    expect(await status()).toMatchObject({ connected: false })
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.audit_events where action = 'microsoft_connection.disconnected'`)).rows[0].n).toBe(1)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.microsoft_check_start(null)`))).rejects.toThrow(/Connect Microsoft first/)
  })

  it('changing the app registration drops the old sign-in', async () => {
    const s = await start()
    await anon(`select public.microsoft_connect_claim($1) r`, [s.state])
    await anon(`select public.microsoft_connect_finish($1, 'rt-9', 'a', 'b') r`, [s.state])
    const other = '11111111-2222-3333-4444-555555555555'
    expect((await db.query<{ r: string }>(`select public.microsoft_configure($1, $2, '') r`, [TENANT, other])).rows[0].r)
      .toBe('updated (the earlier sign-in was removed)')
    expect(await status()).toMatchObject({ client_id: other, connected: false, secret_set: true })
  })
})
