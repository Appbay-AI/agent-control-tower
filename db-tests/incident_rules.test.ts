import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.9: the incident rules (R3.6, R3.7). Done when: each rule proven by a test.
//   1. A Critical incident suspends its agent.  2. Closing needs a named approver.
//   3. Repeat incidents, or 3 switch-ons outside Control Tower, force a review.
//   4. Every drift is recorded with expected, observed, actor, action and result.
describe('incident rules (task 4.9)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let hr: string
  let conn: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    hr = await createDepartment(db, 'HR')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    await grantScope(db, u.ravi, payments)
    await grantScope(db, u.omar, hr)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'appian-key')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  type Row = Record<string, unknown>
  const as = <T = Row>(who: string, sql: string, params: unknown[] = []) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0]?.r)
  const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]

  async function liveAgent(name: string, platform?: string) {
    const id = await proposeAgent(db, u.james, { name, department_id: payments, risk_tier: 'high' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    if (platform) {
      await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
        values ($1, $2, 'Platform agent', 'active', $3::jsonb, $4)`,
        [conn, platform, JSON.stringify({ owner: { email: 'james@bank.test', name: 'James Whitfield' }, tools: ['Refund API'], dataSources: [],
          dataClassifications: ['internal'], sharedWith: [] }), id])
    }
    return id
  }
  const report = (agent: string, title: string, severity = 'high') =>
    as<Row>(u.james, `select to_jsonb(public.report_incident($1, $2, $3::public.risk_tier, 'Seen in the queue')) r`, [agent, title, severity])
  const agentStatus = async (id: string) => (await one<{ s: string }>(`select status s from public.agents where id = $1`, [id])).s
  const resolve = (id: unknown, rootCause = 'data_quality') => asUser(db, u.james, async (tx) => {
    await tx.query(`select public.incident_save_fields($1, $2::jsonb)`, [id, JSON.stringify({ containment: 'Agent suspended', impact: 'One refund',
      personal_data: 'no', root_cause_category: rootCause, root_cause: 'Stale list', remediation: 'List refreshed hourly' })])
    await tx.query(`select public.incident_set_status($1, 'resolved')`, [id])
  })

  // -------------------------------------------------------------------------
  describe('1. a Critical incident suspends its agent', () => {
    it('reported as Critical: suspended at once by Control Tower, on the record, the incident notes it, no second incident', async () => {
      const id = await liveAgent('Refund Bot')
      const inc = await report(id, 'Refunds sent to the wrong accounts', 'critical')
      expect(await agentStatus(id)).toBe('suspended')
      const s = await one<{ status: string; requested_by: string | null; incident_id: string; reason: string }>(
        `select status, requested_by, incident_id, reason from public.agent_suspensions where agent_id = $1`, [id])
      expect(s).toEqual({ status: 'done', requested_by: null, incident_id: inc.id, reason: `Critical incident ${inc.incident_code}: Refunds sent to the wrong accounts` })
      expect((await one<{ n: number }>(`select count(*)::int n from public.incidents where agent_id = $1`, [id])).n).toBe(1)
      const audit = await one<{ actor_type: string; reason: string }>(
        `select actor_type, reason from public.audit_events where agent_id = $1 and action = 'agents.status_changed' order by seq desc limit 1`, [id])
      expect(audit).toEqual({ actor_type: 'system', reason: `Suspended automatically: Critical incident ${inc.incident_code}` })
      const note = await one<{ body: string }>(`select body from public.incident_updates where incident_id = $1 and kind = 'status'`, [inc.id])
      expect(note.body).toMatch(/^AGT-\d{4} suspended automatically: the incident is Critical$/)
      // The stop is carried out like any suspension (enforcement steps planned).
      expect((await one<{ n: number }>(`select count(*)::int n from public.agent_enforcements where agent_id = $1 and action = 'stop'`, [id])).n).toBeGreaterThan(0)
    })

    it('raised to Critical later: suspended then; a High incident alone does not suspend', async () => {
      const id = await liveAgent('Invoice Matcher')
      const inc = await report(id, 'Matched the wrong invoices')
      expect(await agentStatus(id)).toBe('live')
      await as(u.james, `select to_jsonb(public.incident_set_severity($1, 'critical', 'Customers affected')) r`, [inc.id])
      expect(await agentStatus(id)).toBe('suspended')
    })

    it('an agent already suspended is left as it is', async () => {
      const id = await liveAgent('Payroll Checker')
      await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Odd results')`, [id]))
      const before = (await one<{ n: number }>(`select count(*)::int n from public.agent_suspensions where agent_id = $1`, [id])).n
      await report(id, 'More odd results', 'critical')
      expect((await one<{ n: number }>(`select count(*)::int n from public.agent_suspensions where agent_id = $1`, [id])).n).toBe(before)
    })
  })

  // -------------------------------------------------------------------------
  describe('2. closing needs a named approver', () => {
    let agent: string
    let inc: Row
    beforeAll(async () => {
      agent = await liveAgent('Statement Bot')
      inc = await report(agent, 'Wrong balance shown')
    })
    const ask = (who: string, approver: string, note: string | null = null) =>
      as<Row>(who, `select to_jsonb(public.request_incident_closure($1, $2, $3)) r`, [inc.id, approver, note])
    const decide = (who: string, ok: boolean, note: string | null = null) =>
      as<Row>(who, `select to_jsonb(public.decide_incident_closure($1, $2, $3)) r`, [inc.id, ok, note])

    it('only a resolved incident; no setting it to closed directly', async () => {
      await expect(ask(u.james, u.ravi)).rejects.toThrow(/Only a resolved incident can be closed \(it is open\)/)
      await expect(as(u.james, `select to_jsonb(public.incident_set_status($1, 'closed')) r`, [inc.id])).rejects.toThrow(/Closing needs a named approver/)
      await expect(asUser(db, u.admin, (tx) => tx.query(`update public.incidents set status = 'closed' where id = $1`, [inc.id]))).rejects.toThrow(/permission denied/)
    })

    it('the approver must be someone else, and an admin or an approver for the agent\'s department', async () => {
      await resolve(inc.id)
      await expect(ask(u.james, u.james)).rejects.toThrow(/Name someone else/)
      await expect(ask(u.james, u.omar)).rejects.toThrow(/must be an admin or an approver for the agent's department/)
      const names = await asUser(db, u.james, async (tx) => (await tx.query<{ full_name: string }>(
        `select full_name from public.incident_closure_approvers($1)`, [inc.id])).rows.map((r) => r.full_name))
      expect(names).toEqual(['Platform Admin', 'Ravi Menon'])
    })

    it('asked of Ravi: Ravi is told; nobody else can decide; turning it down needs a reason and leaves it resolved', async () => {
      await db.query(`delete from public.push_outbox`)
      expect(await ask(u.james, u.ravi, 'Fix confirmed in production')).toMatchObject({ status: 'resolved', closure_approver_id: u.ravi })
      expect((await db.query(`select user_id, title from public.push_outbox where kind = 'incident_closure'`)).rows)
        .toEqual([{ user_id: u.ravi, title: expect.stringMatching(/^Close INC-\d{4}\? · AGT-\d{4}$/) }])
      await expect(decide(u.james, true)).rejects.toThrow(/Only Ravi Menon can decide this closure/)
      await expect(decide(u.admin, true)).rejects.toThrow(/Only Ravi Menon can decide this closure/)
      await expect(decide(u.ravi, false)).rejects.toThrow(/Say why it is not closed/)
      expect(await decide(u.ravi, false, 'Root cause needs more detail')).toMatchObject({ status: 'resolved', closure_approver_id: null })
    })

    it('approved by the named approver: closed, with who closed it, on the record; the asker is told', async () => {
      await ask(u.james, u.ravi)
      await db.query(`delete from public.push_outbox`)
      const closed = await decide(u.ravi, true, 'Agreed')
      expect(closed).toMatchObject({ status: 'closed', closed_by: u.ravi, closure_requested_by: u.james })
      expect(closed.closed_at).not.toBeNull()
      expect((await db.query(`select user_id, title from public.push_outbox where kind = 'incident_closure'`)).rows)
        .toEqual([{ user_id: u.james, title: expect.stringMatching(/^Closed INC-\d{4} · AGT-\d{4}$/) }])
      const log = (await db.query<{ body: string }>(`select body from public.incident_updates where incident_id = $1 and kind = 'status' order by created_at, id`, [inc.id])).rows.map((r) => r.body)
      expect(log.slice(-4)).toEqual(['Closure asked of Ravi Menon: Fix confirmed in production', 'Closure turned down by Ravi Menon: Root cause needs more detail',
        'Closure asked of Ravi Menon', 'Closed: approved by Ravi Menon: Agreed'])
      await expect(as(u.james, `select to_jsonb(public.incident_save_fields($1, '{"impact":"x"}'::jsonb)) r`, [inc.id])).rejects.toThrow(/closed/i)
    })

    it('reopening drops a closure that was waiting', async () => {
      const i2 = await report(agent, 'Another wrong balance')
      await resolve(i2.id, 'model_error')
      await as(u.james, `select to_jsonb(public.request_incident_closure($1, $2)) r`, [i2.id, u.ravi])
      const back = await as<Row>(u.james, `select to_jsonb(public.incident_set_status($1, 'contained', 'Seen again')) r`, [i2.id])
      expect(back).toMatchObject({ status: 'contained', closure_approver_id: null })
      await expect(as(u.ravi, `select to_jsonb(public.decide_incident_closure($1, true)) r`, [i2.id])).rejects.toThrow(/No closure is waiting/)
    })
  })

  // -------------------------------------------------------------------------
  describe('3. repeats force a review', () => {
    const required = async (id: string) => one<{ reason: string | null; next: string; today: string }>(
      `select review_required_reason reason, next_review_date::text next, current_date::text today from public.agents where id = $1`, [id])
    const alert = async (id: string) => (await one<{ message: string }>(
      `select message from public.alerts where agent_id = $1 and kind = 'review_required' and resolved_at is null`, [id]))?.message ?? null

    it('the same root cause twice in 90 days: review due now, alert, owner and admins told', async () => {
      const id = await liveAgent('Claims Triage')
      const a = await report(id, 'Wrong claim priority')
      await resolve(a.id, 'data_quality')
      expect((await required(id)).reason).toBeNull()
      await db.query(`delete from public.push_outbox`)
      const b = await report(id, 'Wrong claim priority again')
      expect((await required(id)).reason).toBeNull() // no root cause yet
      await as(u.james, `select to_jsonb(public.incident_save_fields($1, '{"root_cause_category":"data_quality"}'::jsonb)) r`, [b.id])
      const r = await required(id)
      expect(r.reason).toBe(`the same root cause twice in 90 days (Data Quality: ${a.incident_code}, ${b.incident_code})`)
      expect(r.next).toBe(r.today)
      expect(await alert(id)).toMatch(/^AGT-\d{4} must be reviewed now: the same root cause twice .* It cannot be asked back on until a review is recorded\.$/)
      expect((await db.query<{ user_id: string }>(`select user_id from public.push_outbox where kind = 'review_required'`)).rows.map((x) => x.user_id).sort())
        .toEqual([u.admin, u.james].sort())
    })

    it('3 incidents of any kind in 90 days; a suspended agent cannot be asked back on until a review is recorded, which clears it', async () => {
      const id = await liveAgent('Fraud Screener')
      await report(id, 'One')
      await report(id, 'Two')
      expect((await required(id)).reason).toBeNull()
      await report(id, 'Three', 'critical') // also suspends it (rule 1)
      expect((await required(id)).reason).toMatch(/^3 incidents in 90 days \(INC-\d{4}, INC-\d{4}, INC-\d{4}\)$/)
      expect(await agentStatus(id)).toBe('suspended')
      await db.query(`update public.incidents set status = 'contained', containment = 'Suspended' where agent_id = $1`, [id])
      await expect(as(u.james, `select public.request_reactivation($1, 'Fixed') r`, [id])).rejects.toThrow(/Record the required review first \(3 incidents in 90 days/)
      await as(u.james, `select public.record_review($1, 'changes_required', 'Thresholds tightened') r`, [id])
      expect((await required(id)).reason).toBeNull()
      expect(await alert(id)).toBeNull()
      expect(await as(u.james, `select public.request_reactivation($1, 'Fixed') r`, [id])).toBeTruthy()
    })

    it('old incidents (over 90 days) do not count', async () => {
      const id = await liveAgent('Loan Checker')
      await report(id, 'One')
      await report(id, 'Two')
      await db.query(`update public.incidents set opened_at = now() - interval '100 days' where agent_id = $1`, [id])
      await report(id, 'Three')
      expect((await required(id)).reason).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('3b + 4. switched on outside Control Tower: drift recorded; the third time forces a review', () => {
    const anon = <T>(sql: string, params: unknown[]) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0].r)
    const lastToken = async (path: string) => (await one<{ token: string }>(
      `select body ->> 'token' token from net.calls where url like $1 order by id desc limit 1`, [`%${path}`])).token
    async function confirmEnforcement(ok = true) {
      await db.query(`update public.agent_enforcements set next_attempt_at = now() - interval '1 second' where status = 'pending'`)
      await db.query(`select public.enforcement_kick()`)
      const t = await lastToken('/enforce/run')
      const work = await anon<{ platform: { id: number }[] }>(`select public.enforcement_claim($1) r`, [t])
      await anon(`select public.enforcement_report($1, $2::jsonb) r`, [t, JSON.stringify(work.platform.map((w) => (
        { id: w.id, ok, detail: ok ? 'Blocked; read back as blocked' : 'Appian did not answer', retry: !ok })))])
    }
    async function switchedOn(changedBy: string | null) {
      await db.query(`select public.platform_reconcile_due()`)
      const t = await lastToken('/platforms/run')
      const job = await anon<{ targets: { platform_agent_id: string }[] }>(`select public.platform_job_claim($1) r`, [t])
      await anon(`select public.platform_reconcile_apply($1, $2::jsonb) r`,
        [t, JSON.stringify(job.targets.map((x) => ({ platform_agent_id: x.platform_agent_id, status: 'active', changed_by: changedBy })))])
      await anon(`select public.platform_job_report($1, true, 'Checked', null) r`, [t])
    }
    const drifts = async (id: string) => (await db.query<{ kind: string; expected: string; observed: string; actor: string; action: string; result: string; incident: string | null }>(
      `select d.kind, d.expected, d.observed, d.actor, d.action, d.result, i.incident_code incident
         from public.drift_events d left join public.incidents i on i.id = d.incident_id where d.agent_id = $1 order by d.detected_at, d.id`, [id])).rows
    let id: string

    it('each switch-on is a drift record: expected, observed, actor (unknown unless Appian says), action and result', async () => {
      id = await liveAgent('Refund Processor', 'NAP-001')
      await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Paid the wrong supplier')`, [id]))
      await confirmEnforcement()
      await switchedOn(null)
      const [d] = await drifts(id)
      expect(d).toEqual({ kind: 'switched_on_outside', expected: `Blocked on ${PLATFORM} (suspended in Control Tower)`,
        observed: `Active on ${PLATFORM} as NAP-001`, actor: 'Unknown, outside Control Tower',
        action: `Blocked again; Critical incident ${d.incident}; admins alerted`, result: 'Blocking again…', incident: expect.stringMatching(/^INC-\d{4}$/) })
      await confirmEnforcement()
      expect((await drifts(id))[0].result).toMatch(/^Blocked again and read back as blocked at \d{2} \w{3} \d{2}:\d{2} UTC$/)
    })

    it('Appian names who did it: the actor is recorded; a failed re-block shows in the result', async () => {
      await switchedOn('maria.lopez')
      await confirmEnforcement(false)
      const d = (await drifts(id))[1]
      expect(d.actor).toBe(`maria.lopez on ${PLATFORM} (outside Control Tower)`)
      expect(d.result).toBe('Not blocked yet: Appian did not answer. Trying again')
      // Its suspension incident and two switch-ons: 3 incidents in 90 days already force a review.
      expect((await required(id)).reason).toMatch(/^3 incidents in 90 days/)
    })

    it('the third switch-on in 90 days forces a review (named for what it is)', async () => {
      await as(u.james, `select public.record_review($1, 'changes_required', 'Access to Appian tightened') r`, [id])
      expect((await required(id)).reason).toBeNull()
      await confirmEnforcement()
      await switchedOn(null)
      expect((await required(id)).reason).toMatch(/^switched back on outside Control Tower 3 times in 90 days \(INC-\d{4}, INC-\d{4}, INC-\d{4}\)$/)
    })

    const required = async (agent: string) => one<{ reason: string | null }>(`select review_required_reason reason from public.agents where id = $1`, [agent])

    it('owner, sharing and capabilities changed on the platform: each a drift with what was expected and what was seen', async () => {
      const a = await liveAgent('Sales Summariser', 'NAP-003')
      const pa = (await one<{ id: string }>(`select id from public.platform_agents where external_id = 'NAP-003'`)).id
      await db.query(`update public.platform_agents set details = details || $1::jsonb where id = $2`, [JSON.stringify({
        owner: { email: 'ana@bank.test', name: 'Ana Costa' },
        sharedWith: [{ email: 'ben@bank.test', name: 'Ben Ode', jobTitle: 'Sales Associate' }],
        tools: ['Refund API', 'Email'] }), pa])
      const d = (await drifts(a)).sort((x, y) => ['owner_changed', 'sharing_changed', 'capabilities_changed'].indexOf(x.kind)
        - ['owner_changed', 'sharing_changed', 'capabilities_changed'].indexOf(y.kind))
      expect(d.map((x) => x.kind)).toEqual(['owner_changed', 'sharing_changed', 'capabilities_changed'])
      expect(d[0]).toMatchObject({ expected: `Owner on ${PLATFORM}: James Whitfield`, observed: `Owner on ${PLATFORM}: Ana Costa`, actor: 'Unknown, outside Control Tower' })
      expect(d[1]).toMatchObject({ expected: 'Shared with nobody', observed: 'Shared with Ben Ode (Sales Associate)',
        action: 'Recorded; everyone with access checked against the data-authority matrix' })
      expect(d[2]).toMatchObject({ expected: 'Tools: Refund API. Data sources: none. Data: Internal',
        observed: 'Tools: Email, Refund API. Data sources: none. Data: Internal', action: 'Registry updated from the platform; data authority checked again' })
      // An unchanged sync records nothing.
      await db.query(`update public.platform_agents set details = details where id = $1`, [pa])
      expect(await drifts(a)).toHaveLength(3)
    })

    it('a Live agent blocked on its platform by someone else is recorded (not a Control Tower stop)', async () => {
      const a = await liveAgent('Doc Reader', 'NAP-004')
      await db.query(`update public.platform_agents set status = 'blocked', details = details || '{"statusChangedBy":"ops.user"}'::jsonb where external_id = 'NAP-004'`)
      expect(await drifts(a)).toEqual([{ kind: 'blocked_outside', expected: `Active on ${PLATFORM} (Live in Control Tower)`,
        observed: `Blocked on ${PLATFORM} as NAP-004`, actor: `ops.user on ${PLATFORM} (outside Control Tower)`, action: 'Recorded',
        result: 'No change in Control Tower: the agent stays Live here; its platform is stopping it', incident: null }])
    })

    it('drift records: read-only, and seen only by people who can see the agent', async () => {
      await expect(asUser(db, u.admin, (tx) => tx.query(`delete from public.drift_events`))).rejects.toThrow(/permission denied/)
      const seen = async (who: string) => asUser(db, who, async (tx) => (await tx.query<{ n: number }>(`select count(*)::int n from public.drift_events`)).rows[0].n)
      expect(await seen(u.james)).toBeGreaterThan(0)
      expect(await seen(u.omar)).toBe(0)
    })
  })
})
