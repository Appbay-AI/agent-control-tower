import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createUser } from './harness'

const seedFile = (f: string) => readFileSync(path.resolve(__dirname, '../supabase/seed', f), 'utf8')
// psql runs these in one session; so does the test.
const SEED = ['00_helpers.sql', '02_demo_bank.sql', '03_more_agents.sql', '04_routing.sql', '07_history.sql', '05_action_requests.sql', '06_agent_logs.sql'].map(seedFile).join('\n')
const PERSONAS = ['admin', 'priya.sharma', 'ravi.menon', 'daniel.okafor', 'sara.haddad', 'omar.farouk',
  'james.whitfield', 'aisha.rahman', 'tom.becker', 'lucy.grant', 'mei.lin']

describe('Northbridge demo bank seed', () => {
  let db: PGlite
  const q = async <T,>(sql: string) => (await db.query<T>(sql)).rows

  beforeAll(async () => {
    db = await createDb()
    // 01_users.sql writes Supabase's auth tables; here the harness creates the same personas.
    for (const p of PERSONAS) await createUser(db, `${p}@northbridge.demo`)
    await db.exec(SEED)
  }, 120000)

  it('creates the registry with every lifecycle state', async () => {
    const rows = await q<{ status: string; n: number }>(`select status::text, count(*)::int n from public.agents group by 1 order by 1`)
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ live: 33, proposed: 6, retired: 1 })
  })

  it('loads the demo routing rules once, however often it runs', async () => {
    await db.exec(seedFile('04_routing.sql'))
    const rules = await q<{ name: string; approver: string }>(
      `select r.name, p.email approver from public.routing_rules r join public.profiles p on p.id = r.approver_id order by r.priority`)
    expect(rules).toEqual([
      { name: 'Large payments (£1m and above)', approver: 'ravi.menon@northbridge.demo' },
      { name: 'Agents that touch personal data', approver: 'omar.farouk@northbridge.demo' },
    ])
  })

  it('leaves the £2m payment waiting in Ravi\'s queue (four-eyes) and three rotas with Omar, once however often it runs', async () => {
    await db.exec(seedFile('00_helpers.sql') + seedFile('05_action_requests.sql'))
    const rows = await q<{ agent: string; status: string; amount: string | null; assignee: string; required: number; days_left: number; live_keys: number }>(`
      select a.name agent, r.status::text, r.amount::text, p.email assignee, r.required_approvals required,
             round(extract(epoch from r.due_at - now()) / 86400)::int days_left,
             (select count(*)::int from public.agent_api_keys k where k.agent_id = r.agent_id and k.revoked_at is null) live_keys
      from public.action_requests r join public.profiles p on p.id = r.assigned_to join public.agents a on a.id = r.agent_id
      where r.status = 'pending' order by a.name, r.description`)
    expect(rows).toEqual([
      ...['Bristol', 'Leeds', 'Manchester'].map(() => ({ agent: 'Branch Rota Planner', status: 'pending', amount: null,
        assignee: 'omar.farouk@northbridge.demo', required: 1, days_left: 3, live_keys: 0 })),
      { agent: 'Payment Release Assistant', status: 'pending', amount: '2000000.00', assignee: 'ravi.menon@northbridge.demo',
        required: 2, days_left: 3, live_keys: 0 },
    ])
    const hold = await q<{ h: string }>(`select hold_reason h from public.action_requests where amount = 2000000`)
    expect(hold[0].h).toMatch(/outside its limits/)
  })

  it('flags the Cash Forecast Agent as silent and gives the £2m payment a log, once however often it runs', async () => {
    await db.exec(seedFile('00_helpers.sql') + seedFile('06_agent_logs.sql'))
    const silent = await q<{ name: string; message: string; limit: number }>(`
      select a.name, al.message, a.silent_after_minutes "limit" from public.alerts al join public.agents a on a.id = al.agent_id
      where al.kind = 'agent_silent' and al.resolved_at is null`)
    expect(silent).toEqual([{ name: 'Cash Forecast Agent', limit: 60, message: expect.stringMatching(/has gone silent: nothing heard from it for more than 1 hour$/) }])
    const logs = await q<{ name: string; n: number; linked: number; last: string }>(`
      select a.name, count(*)::int n, count(l.request_id)::int linked,
             (array_agg(l.level order by l.occurred_at desc))[1] last
      from public.agent_logs l join public.agents a on a.id = l.agent_id group by a.name order by a.name`)
    expect(logs).toEqual([
      { name: 'Cash Forecast Agent', n: 5, linked: 0, last: 'error' },
      { name: 'Payment Release Assistant', n: 4, linked: 2, last: 'info' },
    ])
  })

  it('tells the story: six live agents without owners, four overdue reviews, one shadow agent', async () => {
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents where status = 'live' and business_owner_id is null`))[0].n).toBe(6)
    const alerts = await q<{ kind: string; n: number }>(
      `select kind::text, count(*)::int n from public.alerts where resolved_at is null group by 1 order by 1`)
    expect(Object.fromEntries(alerts.map((a) => [a.kind, a.n]))).toEqual({ agent_silent: 1, owner_missing: 6, review_overdue: 4 })
    const shadow = await q<{ registration_source: string; business_owner_id: string | null }>(
      `select registration_source, business_owner_id from public.agents where name = 'Copilot for Ops Tickets'`)
    expect(shadow[0]).toEqual({ registration_source: 'discovered', business_owner_id: null })
  })

  it('leaves work in the approval queues, including a four-eyes approval half done', async () => {
    const pending = await q<{ name: string; required_approvals: number; approvals: number }>(`
      select a.name, r.required_approvals,
             (select count(*)::int from public.registration_decisions d where d.registration_id = r.id and d.decision = 'approve') approvals
      from public.agent_registrations r join public.agents a on a.id = r.agent_id
      where r.status = 'pending' order by a.name`)
    expect(pending).toEqual([
      { name: 'Cloud Cost Optimiser', required_approvals: 1, approvals: 0 },
      { name: 'FX Payment Router', required_approvals: 2, approvals: 1 },
      { name: 'Supplier Onboarding Bot', required_approvals: 1, approvals: 0 },
    ])
    const sentBack = await q<{ status: string }>(`
      select r.status::text from public.agent_registrations r join public.agents a on a.id = r.agent_id
      where a.name = 'Mortgage Pre-qualifier'`)
    expect(sentBack[0].status).toBe('sent_back')
  })

  // Task 7.1 (final demo data): twelve weeks of history for the Phase 4 to 6 screens.
  describe('the last twelve weeks', () => {
    type Row = Record<string, unknown>
    const as = async <T = Row>(email: string, sql: string) => {
      const id = (await q<{ id: string }>(`select id from public.profiles where email = '${email}'`))[0].id
      return asUser(db, id, async (tx) => (await tx.query<{ r: T }>(sql)).rows[0].r)
    }

    it('agents asked every week; people decided, a few said no; policy refused observe-only agents that tried to act', async () => {
      const rows = await q<{ status: string; source: string | null; n: number }>(`
        select status::text, decision_source source, count(*)::int n from public.action_requests
         where idempotency_key like 'hist-%' group by 1, 2 order by 1, 2`)
      expect(rows).toEqual([
        { status: 'approved', source: 'human', n: 55 }, { status: 'approved', source: 'policy', n: 12 },
        { status: 'refused', source: 'policy', n: 5 }, { status: 'rejected', source: 'human', n: 5 }])
      const span = (await q<{ oldest: number; newest: number; future: number; undated: number }>(`
        select max(current_date - requested_at::date) oldest, min(current_date - requested_at::date) newest,
               count(*) filter (where decided_at > now() or requested_at > now())::int future,
               count(*) filter (where decided_at < requested_at)::int undated
          from public.action_requests where idempotency_key like 'hist-%'`))[0]
      expect(span).toEqual({ oldest: 82, newest: 1, future: 0, undated: 0 })
      const refused = await q<{ name: string }>(`select distinct a.name from public.action_requests r join public.agents a on a.id = r.agent_id
        where r.status = 'refused' order by 1`)
      expect(refused.map((r) => r.name)).toEqual(['Cash Forecast Agent', 'Sanctions Pre-screener'])
    })

    it('the time to decide falls week by week on the executive dashboard', async () => {
      const d = await as<{ approval_time_by_week: { decided: number; avg_minutes: number | null }[] }>('priya.sharma@northbridge.demo', `select public.executive_dashboard() r`)
      const weeks = d.approval_time_by_week.filter((w) => w.decided > 0)
      expect(weeks.length).toBeGreaterThanOrEqual(7)
      expect(weeks[0].avg_minutes!).toBeGreaterThan(3 * weeks[weeks.length - 1].avg_minutes!)
    })

    it('seven incidents: five closed, one waiting for Ravi to approve its closure, one open and past its time limit', async () => {
      const inc = await q<{ agent: string; status: string; severity: string; days: number; overdue: boolean; closer: string | null }>(`
        select a.name agent, i.status, i.severity::text, current_date - i.opened_at::date days, i.due_at < now() and i.status = 'open' overdue,
               (select email from public.profiles where id = coalesce(i.closed_by, i.closure_approver_id)) closer
          from public.incidents i join public.agents a on a.id = i.agent_id order by i.opened_at`)
      expect(inc).toEqual([
        { agent: 'Chat Refund Agent', status: 'closed', severity: 'high', days: 74, overdue: false, closer: 'omar.farouk@northbridge.demo' },
        { agent: 'Collections Outreach Agent', status: 'closed', severity: 'medium', days: 61, overdue: false, closer: 'sara.haddad@northbridge.demo' },
        { agent: 'Reconciliation Exceptions Agent', status: 'closed', severity: 'high', days: 47, overdue: false, closer: 'omar.farouk@northbridge.demo' },
        { agent: 'Payment Release Assistant', status: 'closed', severity: 'critical', days: 33, overdue: false, closer: 'ravi.menon@northbridge.demo' },
        { agent: 'Chat Refund Agent', status: 'closed', severity: 'low', days: 19, overdue: false, closer: 'omar.farouk@northbridge.demo' },
        { agent: 'Complaint Classifier', status: 'resolved', severity: 'medium', days: 9, overdue: false, closer: 'ravi.menon@northbridge.demo' },
        { agent: 'Affordability Checker', status: 'open', severity: 'high', days: 2, overdue: true, closer: null },
      ])
      // Each case's notes run in order from opening to its last step.
      expect((await q<{ n: number }>(`select count(*)::int n from public.incident_updates u join public.incidents i on i.id = u.incident_id
        where u.created_at < i.opened_at or u.created_at > coalesce(i.closed_at, i.closure_requested_at, now())`))[0].n).toBe(0)
    })

    it('the kill switch five weeks ago: suspended, its owner told to stop it, the incident closed, switched back on by two approvers', async () => {
      const s = (await q<{ status: string; days: number; reason: string }>(`select s.status, current_date - s.suspended_at::date days, s.reason
        from public.agent_suspensions s join public.agents a on a.id = s.agent_id where a.name = 'Payment Release Assistant'`))
      expect(s).toEqual([{ status: 'done', days: 33, reason: expect.stringMatching(/^Critical incident INC-0004: Same supplier invoice paid twice$/) }])
      const steps = await q<{ action: string; status: string; detail: string }>(`select e.action, e.status, e.detail from public.agent_enforcements e
        join public.agents a on a.id = e.agent_id where a.name = 'Payment Release Assistant' order by e.id`)
      expect(steps).toEqual([
        // No control endpoint and no key at the time, so its owner was emailed (task 4.2).
        { action: 'stop', status: 'done', detail: expect.stringMatching(/^Emailed .+, asking them to switch it off$/) },
        { action: 'restore', status: 'done', detail: expect.stringMatching(/^Emailed .+, saying it may be switched back on$/) }])
      const r = await q<{ status: string; approvers: string }>(`select r.status, (select string_agg(p.email, ',' order by x.approved_at) from public.agent_reactivation_approvals x
        join public.profiles p on p.id = x.approver_id where x.reactivation_id = r.id) approvers from public.agent_reactivations r`)
      expect(r).toEqual([{ status: 'approved', approvers: 'daniel.okafor@northbridge.demo,ravi.menon@northbridge.demo' }])
      expect((await q<{ status: string }>(`select status::text from public.agents where name = 'Payment Release Assistant'`))[0].status).toBe('live')
    })

    it('fills the drift report, the risk view and the evidence pack', async () => {
      expect((await q<{ n: number }>(`select count(*)::int n from public.drift_events`))[0].n).toBe(5)
      const risk = await as<{ totals: Record<string, number> }>('priya.sharma@northbridge.demo', `select public.risk_dashboard() r`)
      expect(risk.totals).toMatchObject({ refused: 5, incident: 7, drift: 5 })
      const pack = await as<Record<string, { total: number }>>('mei.lin@northbridge.demo', `select public.evidence_pack(current_date - 90, current_date) r`)
      expect(Object.fromEntries(['incidents', 'autonomy', 'suspensions', 'reactivations', 'enforcement', 'drift'].map((k) => [k, pack[k].total])))
        .toEqual({ incidents: 7, autonomy: 2, suspensions: 1, reactivations: 1, enforcement: 2, drift: 5 })
    })

    it('nobody is emailed or alerted about the past: only today\'s waiting requests are in the outboxes', async () => {
      const out = (await q<{ push: number; email: number; notes: number }>(`select
        (select count(*)::int from public.push_outbox where request_id is null or request_id not in (select id from public.action_requests where status = 'pending')) push,
        (select count(*)::int from public.email_outbox where request_id is null or request_id not in (select id from public.action_requests where status = 'pending')) email,
        (select count(*)::int from public.notifications where created_at < now() - interval '1 hour') notes`))[0]
      expect(out).toEqual({ push: 0, email: 0, notes: 0 })
    })
  })

  it('names the real personas in the audit trail, and the chain verifies', async () => {
    const who = await q<{ full_name: string }>(`
      select p.full_name from public.audit_events e join public.profiles p on p.id = e.actor_id
      where e.action = 'agents.status_changed' and e.summary like 'AGT-0001: proposed → approved'`)
    expect(who[0].full_name).toBe('ravi.menon')
    expect(await q(`select * from public.audit_verify_chain()`)).toEqual([])
    const daniel = await q<{ is_active: boolean; roles: string; scopes: number }>(`
      select p.is_active, (select string_agg(role::text, ',') from public.user_roles where user_id = p.id) roles,
             (select count(*)::int from public.approver_scopes where user_id = p.id) scopes
      from public.profiles p where email = 'daniel.okafor@northbridge.demo'`)
    expect(daniel[0]).toEqual({ is_active: true, roles: 'approver', scopes: 2 })
  })

  it('spreads history over the past year, with completed reviews', async () => {
    const span = await q<{ oldest: number; reviews: number }>(`
      select (current_date - min(created_at)::date) oldest, (select count(*)::int from public.agent_reviews) reviews
      from public.agents`)
    expect(span[0].oldest).toBeGreaterThan(365)
    expect(span[0].reviews).toBe(10)
  })

  it('can be run again without duplicating anything', async () => {
    const before = (await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n
    await db.exec(SEED)
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(40)
    // Only the alert refresh may run again, and it raises nothing new.
    expect((await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n).toBe(before)
  })

  it('can be reset and reloaded to exactly the same story, with a fresh audit chain', async () => {
    // Something done to a persona during a demo: Daniel deactivated and stripped of his roles.
    await db.exec(`
      update public.profiles set is_active = false where email = 'daniel.okafor@northbridge.demo';
      delete from public.user_roles where user_id = (select id from public.profiles where email = 'daniel.okafor@northbridge.demo');
      delete from public.approver_scopes where user_id = (select id from public.profiles where email = 'daniel.okafor@northbridge.demo');`)
    await db.exec(seedFile('90_reset.sql'))
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(0)
    expect((await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n).toBe(0)
    await db.exec(SEED)
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(40)
    expect((await q<{ c: string }>(`select agent_code c from public.agents where name = 'Payment Release Assistant'`))[0].c).toBe('AGT-0001')
    expect(await q(`select * from public.audit_verify_chain()`)).toEqual([])
    const daniel = await q<{ is_active: boolean; roles: string; scopes: number }>(`
      select p.is_active, (select string_agg(role::text, ',') from public.user_roles where user_id = p.id) roles,
             (select count(*)::int from public.approver_scopes where user_id = p.id) scopes
      from public.profiles p where email = 'daniel.okafor@northbridge.demo'`)
    expect(daniel[0]).toEqual({ is_active: true, roles: 'approver', scopes: 2 })
    // The guards are back on after the reset.
    await expect(db.query(`delete from public.audit_events where seq = 1`)).rejects.toThrow(/insert-only/)
  })
})
