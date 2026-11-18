// Task 6.5: the operational dashboard ("My work"). What is past its deadline, what waits for my decision, and the
// agents I own, for the signed-in person only (my_dashboard() reads nobody else's). Done when: each user sees only
// their own.
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { TIER_LABEL } from '@/lib/dashboard'
import { day, formatMoney, when } from '@/lib/format'
import { BREACH_LABEL, dueText, waitingCount, type MyWork } from '@/lib/myWork'
import { useAsync } from '@/lib/useAsync'

export function MyWorkPage() {
  const { data, error, loading, reload } = useAsync(() => api.myWork())
  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <><PageHeader title="My work" /><LoadingRows rows={6} /></>
  if (!data) return null
  return <Work w={data} onRefresh={reload} busy={loading} />
}

export function Work({ w, onRefresh, busy }: { w: MyWork; onRefresh: () => void; busy: boolean }) {
  const a = w.approvals
  const waiting = waitingCount(a)
  return (
    <div className="space-y-6" data-testid="my-work">
      <PageHeader title="My work" subtitle={`What needs you, ${w.me ?? ''}: only your own decisions, incidents and agents. As of ${when(w.at)} UTC.`}
        actions={<Button variant="outline" onClick={onRefresh} disabled={busy}><RefreshCw /> Refresh</Button>} />

      <section className="grid grid-cols-3 gap-3" aria-label="My figures">
        <Count label="Past due" value={w.breaches.length} tone={w.breaches.length ? 'bad' : undefined} testId="count-breaches" />
        <Count label="Waiting for my decision" value={waiting} tone={waiting ? 'warn' : undefined} testId="count-waiting" />
        <Count label="My agents" value={w.agents.length} testId="count-agents" />
      </section>

      <Section title="Past due" sub="Mine and past the deadline: decisions waiting for me, incidents I own or on my agents, reviews of my Live agents." testId="breaches"
        empty={w.breaches.length === 0 ? 'Nothing is past due.' : null}>
        <ul className="divide-y">
          {w.breaches.map((b) => (
            <li key={`${b.kind}-${b.id}`} className="flex items-start gap-3 py-2" data-testid="breach" data-kind={b.kind}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-700 dark:text-red-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link to={b.link} className="font-medium break-words hover:underline">{b.title}</Link>
                <div className="text-muted-foreground text-xs">
                  {BREACH_LABEL[b.kind]}{b.kind !== 'review' ? ` · ${b.agent}` : ''}{b.kind === 'incident' ? (b.owner ? ' · you own it' : ' · on your agent') : ''}
                </div>
              </div>
              <span className="shrink-0 text-xs font-medium text-red-700 dark:text-red-400">{dueText(b.due)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Waiting for my decision" sub="Each opens where you decide it. The same rules as the Approvals screen decide what is yours." testId="waiting"
        empty={waiting === 0 ? 'Nothing is waiting for you.' : null}>
        <ul className="divide-y">
          {a.requests.map((r) => (
            <Item key={r.id} kind="Action request" to={`/approvals/requests/${r.id}`} title={`${r.code} ${r.action}${r.amount != null ? `, ${formatMoney(r.amount, r.currency ?? 'GBP')}` : ''}`}
              meta={`${r.agent}${r.assigned ? ' · assigned to you' : ' · any approver for the department'}`} right={dueText(r.due_at)} late={!!r.due_at && Date.parse(r.due_at) < Date.now()} />
          ))}
          {a.registrations.map((r) => (
            <Item key={r.id} kind="Agent to approve" to={`/agents/${r.agent_id}`} title={r.agent} meta={`${TIER_LABEL[r.risk_tier]} risk · submitted ${day(r.submitted_at)}`} />
          ))}
          {a.reactivations.map((r) => (
            <Item key={r.id} kind="Switch back on?" to={`/approvals/reactivations/${r.id}`} title={r.agent} meta={r.reason} />
          ))}
          {a.closures.map((c) => (
            <Item key={c.id} kind="Incident to close" to={`/incidents/${c.id}`} title={`${c.code} ${c.title}`} meta={c.agent} />
          ))}
        </ul>
      </Section>

      <Section title="My agents" sub="Agents you own as business or technical owner (not retired)." testId="agents"
        empty={w.agents.length === 0 ? 'You do not own any agents.' : null}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th className="py-1 text-left font-medium">Agent</th>
                <th className="py-1 pl-3 text-left font-medium">Status</th>
                <th className="py-1 pl-3 text-left font-medium">Next review</th>
                <th className="py-1 pl-3 text-right font-medium">Open incidents</th>
                <th className="py-1 pl-3 text-right font-medium">Waiting requests</th>
              </tr>
            </thead>
            <tbody>
              {w.agents.map((g) => (
                <tr key={g.id} className="border-t" data-testid="my-agent">
                  <td className="py-1.5">
                    <Link to={`/agents/${g.id}`} className="font-medium hover:underline">{g.code} {g.name}</Link>
                    <div className="text-muted-foreground text-xs">{g.role} · {TIER_LABEL[g.risk_tier]} risk</div>
                  </td>
                  <td className="pl-3">{g.status.charAt(0).toUpperCase() + g.status.slice(1)}</td>
                  <td className={`pl-3 ${g.review_overdue ? 'font-medium text-red-700 dark:text-red-400' : ''}`}>
                    {g.next_review ? day(g.next_review) : '—'}{g.review_required && <div className="text-xs text-amber-700 dark:text-amber-400">Review required</div>}
                  </td>
                  <td className={`pl-3 text-right ${g.open_incidents ? 'font-medium text-red-700 dark:text-red-400' : ''}`}>{g.open_incidents}</td>
                  <td className="pl-3 text-right">{g.pending_requests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

function Count({ label, value, tone, testId }: { label: string; value: number; tone?: 'bad' | 'warn'; testId: string }) {
  const color = tone === 'bad' ? 'text-red-700 dark:text-red-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className={`text-2xl font-semibold ${color}`} data-testid={testId}>{value}</div>
      <div className="text-sm font-medium">{label}</div>
    </div>
  )
}

function Section({ title, sub, empty, testId, children }: { title: string; sub: string; empty: string | null; testId: string; children: ReactNode }) {
  return (
    <section className="bg-card rounded-lg border p-4" aria-label={title} data-testid={testId}>
      <h2 className="font-semibold">{title}</h2>
      <p className="text-muted-foreground mb-2 text-xs">{sub}</p>
      {empty ? <p className="text-muted-foreground text-sm">{empty}</p> : children}
    </section>
  )
}

function Item({ kind, to, title, meta, right, late }: { kind: string; to: string; title: string; meta: string; right?: string; late?: boolean }) {
  return (
    <li className="flex items-start gap-3 py-2" data-testid="waiting-item">
      <div className="min-w-0 flex-1">
        <span className="bg-muted text-muted-foreground mb-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium">{kind}</span>
        <Link to={to} className="block font-medium break-words hover:underline">{title}</Link>
        <div className="text-muted-foreground text-xs break-words">{meta}</div>
      </div>
      {right && <span className={`shrink-0 text-xs ${late ? 'font-medium text-red-700 dark:text-red-400' : 'text-muted-foreground'}`}>{right}</span>}
    </li>
  )
}
