import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.5: the incident case: fields, status Open → Contained → Resolved (and reopen), severity, hand-over, notes,
// and reporting from the app. Closing is task 4.9.
describe('incident case (task 4.5)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let agent: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    u.audit = await createUser(db, 'audit@bank.test', ['auditor'], 'Aud Itor')
    u.priya = await createUser(db, 'priya@bank.test', ['owner'], 'Priya Shah')
    await grantScope(db, u.ravi, payments)
    agent = await proposeAgent(db, u.james, { name: 'Refund Bot', department_id: payments, risk_tier: 'high' })
  })

  type Row = Record<string, unknown>
  const as = <T = Row>(who: string, sql: string, params: unknown[] = []) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0]?.r)
  const report = (who: string, title = 'Refunded the wrong customer', severity = 'high') =>
    as<Row>(who, `select to_jsonb(public.report_incident($1, $2, $3::public.risk_tier, 'Seen in the refunds queue')) r`, [agent, title, severity])
  const save = (who: string, id: unknown, fields: object, note: string | null = null) =>
    as<Row>(who, `select to_jsonb(public.incident_save_fields($1, $2::jsonb, $3)) r`, [id, JSON.stringify(fields), note])
  const status = (who: string, id: unknown, s: string, note: string | null = null) =>
    as<Row>(who, `select to_jsonb(public.incident_set_status($1, $2, $3)) r`, [id, s, note])
  const log = async (id: unknown) => (await db.query<{ kind: string; body: string; author: string }>(
    `select u.kind, u.body, p.full_name author from public.incident_updates u left join public.profiles p on p.id = u.author_id
      where incident_id = $1 order by u.created_at, u.id`, [id])).rows

  it('a person reports an incident from the app: owned by the agent\'s business owner, who is told', async () => {
    await db.query(`delete from public.push_outbox`)
    const i = await report(u.ravi)
    expect(i).toMatchObject({ source: 'user_report', severity: 'high', status: 'open', title: 'Refunded the wrong customer',
      description: 'Seen in the refunds queue', reporter: 'Ravi Menon (reported in Control Tower)', owner_id: u.james, sla_minutes: 1440 })
    expect((await db.query<{ user_id: string }>(`select user_id from public.push_outbox where kind = 'incident'`)).rows).toEqual([{ user_id: u.james }])
    await expect(report(u.omar)).rejects.toThrow(/Only admins, the agent's owners and approvers/) // other department
    await expect(report(u.audit)).rejects.toThrow(/Only admins/)                                     // read-only role
    await expect(report(u.ravi, '  ')).rejects.toThrow(/Give the incident a title/)
  })

  it('case fields are saved, logged and audited; only the people who may work on it can change them', async () => {
    const i = await report(u.james, 'Duplicate refund')
    const after = await save(u.ravi, i.id, { impact: '12 customers refunded twice', customers_affected: '12', financial_impact: '3400.50',
      personal_data: 'No', root_cause_category: 'integration' }, 'From the refunds report')
    expect(after).toMatchObject({ impact: '12 customers refunded twice', customers_affected: 12, financial_impact: 3400.5,
      financial_currency: 'GBP', personal_data: 'no', root_cause_category: 'integration' })
    expect(await log(i.id)).toEqual([{ kind: 'fields', author: 'Ravi Menon',
      body: 'Updated Impact, Customers affected, Money involved, Personal data involved, Root cause category: From the refunds report' }])
    // Saving the same values again changes and logs nothing; clearing a field works.
    await save(u.ravi, i.id, { impact: '12 customers refunded twice' })
    expect(await log(i.id)).toHaveLength(1)
    expect(await save(u.james, i.id, { customers_affected: '' })).toMatchObject({ customers_affected: null })
    const audit = (await db.query<{ reason: string }>(`select reason from public.audit_events where entity_type = 'incidents' and entity_id = $1 and action = 'incidents.update' order by seq limit 1`, [i.id])).rows[0]
    expect(audit.reason).toBe('From the refunds report')

    await expect(save(u.omar, i.id, { impact: 'x' })).rejects.toThrow(/Only the incident's owner/)
    await expect(save(u.audit, i.id, { impact: 'x' })).rejects.toThrow(/Only the incident's owner/)
    await expect(save(u.james, i.id, { status: 'closed' })).rejects.toThrow(/Unknown field status/)
    await expect(save(u.james, i.id, { customers_affected: 'twelve' })).rejects.toThrow(/Customers affected is not valid: twelve/)
    await expect(save(u.james, i.id, { financial_impact: '-5' })).rejects.toThrow(/cannot be negative/)
    await expect(save(u.james, i.id, { personal_data: 'maybe' })).rejects.toThrow(/yes, no or unknown/)
    await expect(save(u.james, i.id, { root_cause_category: 'gremlins' })).rejects.toThrow(/Root cause category is not valid/)
    await expect(save(u.james, i.id, { financial_currency: 'pounds' })).rejects.toThrow(/three-letter code/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`update public.incidents set impact = 'x' where id = $1`, [i.id]))).rejects.toThrow(/permission denied/)
  })

  it('status: contained needs containment; resolved needs the whole case; reopening needs a reason; closing waits for 4.9', async () => {
    const i = await report(u.james, 'Paid a blocked supplier')
    await expect(status(u.james, i.id, 'contained')).rejects.toThrow(/Before marking it contained, fill in: containment/)
    await save(u.james, i.id, { containment: 'Agent suspended; payment recalled' })
    expect(await status(u.james, i.id, 'contained')).toMatchObject({ status: 'contained', resolved_at: null })
    await expect(status(u.james, i.id, 'resolved')).rejects.toThrow(
      /fill in: impact, whether personal data was involved, root cause category, root cause, remediation/)
    await save(u.james, i.id, { impact: 'One payment of £9,000, recalled', personal_data: 'no', root_cause_category: 'data_quality',
      root_cause: 'Supplier block list was a day old', remediation: 'Block list now refreshed hourly' })
    const resolved = await status(u.admin, i.id, 'resolved', 'Recall confirmed by the bank')
    expect(resolved).toMatchObject({ status: 'resolved' })
    expect(resolved.contained_at).not.toBeNull()
    expect(resolved.resolved_at).not.toBeNull()

    await expect(status(u.james, i.id, 'open')).rejects.toThrow(/Say why it is reopened/)
    expect(await status(u.james, i.id, 'contained', 'Second payment found')).toMatchObject({ status: 'contained', resolved_at: null })
    await expect(status(u.james, i.id, 'closed')).rejects.toThrow(/Closing needs a named approver/)
    await expect(status(u.james, i.id, 'fixed')).rejects.toThrow(/Unknown status/)
    expect((await log(i.id)).filter((l) => l.kind === 'status').map((l) => l.body))
      .toEqual(['Contained', 'Resolved: Recall confirmed by the bank', 'Contained: Second payment found'])
  })

  it('severity changes with a reason and the time to resolve follows from when it opened', async () => {
    const i = await report(u.james, 'Slow replies', 'low')
    expect(i.sla_minutes).toBe(10080)
    await expect(as(u.james, `select public.incident_set_severity($1, 'critical', '')`, [i.id])).rejects.toThrow(/Say why the severity changes/)
    const after = await as<Row>(u.james, `select to_jsonb(public.incident_set_severity($1, 'critical', 'Customers are complaining')) r`, [i.id])
    expect(after).toMatchObject({ severity: 'critical', sla_minutes: 240 })
    const mins = (await db.query<{ m: number }>(`select extract(epoch from due_at - opened_at)::int / 60 m from public.incidents where id = $1`, [i.id])).rows[0].m
    expect(mins).toBe(240)
    expect((await log(i.id)).at(-1)).toMatchObject({ kind: 'severity', body: 'Severity Low → Critical: Customers are complaining' })
  })

  it('hand-over to another active person, with a reason; they are told and can then work on it', async () => {
    const i = await report(u.james, 'Wrong refund amount')
    await db.query(`delete from public.push_outbox`)
    await expect(as(u.james, `select public.incident_reassign($1, $2, '')`, [i.id, u.priya])).rejects.toThrow(/Say why it is handed over/)
    const after = await as<Row>(u.james, `select to_jsonb(public.incident_reassign($1, $2, 'Priya runs refunds')) r`, [i.id, u.priya])
    expect(after).toMatchObject({ owner_id: u.priya, owner_reason: 'Handed over by James Whitfield' })
    const push = (await db.query<{ user_id: string; body: string; url: string }>(`select user_id, body, url from public.push_outbox where kind = 'incident'`)).rows
    expect(push).toEqual([{ user_id: u.priya, url: `/incidents/${i.id}`, body: expect.stringMatching(/^Handed to you: Wrong refund amount\. Resolve by /) }])
    // Priya is not an owner of the agent, but as the incident's owner she can see and work on it.
    expect(await as<number>(u.priya, `select count(*)::int r from public.incidents where id = $1`, [i.id])).toBe(1)
    await save(u.priya, i.id, { containment: 'Refunds paused' })
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.omar])
    await expect(as(u.priya, `select public.incident_reassign($1, $2, 'x')`, [i.id, u.omar])).rejects.toThrow(/must be an active user/)
    await db.query(`update public.profiles set is_active = true where id = $1`, [u.omar])
  })

  it('notes go on the log; the log is visible to whoever can see the incident', async () => {
    const i = await report(u.james, 'Note test')
    await as(u.ravi, `select public.incident_add_note($1, 'Called the customer')`, [i.id])
    await expect(as(u.ravi, `select public.incident_add_note($1, '  ')`, [i.id])).rejects.toThrow(/Write the note first/)
    const seen = (who: string) => as<number>(who, `select count(*)::int r from public.incident_updates where incident_id = $1`, [i.id])
    expect(await seen(u.audit)).toBe(1)
    expect(await seen(u.omar)).toBe(0)
    expect((await log(i.id))[0]).toEqual({ kind: 'note', body: 'Called the customer', author: 'Ravi Menon' })
  })
})
