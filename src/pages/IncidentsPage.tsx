// Task 4.4: every incident the user may see, open ones first, each with its owner and time to resolve.
// Admins set the time to resolve for each severity. The full case screen (impact, containment, root cause,
// remediation) is task 4.5.
import { useMemo, useState, type FormEvent } from 'react'
import { DriftList } from '@/components/DriftList'
import { IncidentList } from '@/components/IncidentList'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage, RISK_LABEL } from '@/lib/format'
import { incidentDue, isOpen, SEVERITIES, sortIncidents } from '@/lib/incidents'
import { durationText } from '@/lib/sla'
import type { IncidentSla, RiskTier } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export function IncidentsPage() {
  const { hasRole, session } = useAuth()
  const me = session!.user.id
  const [show, setShow] = useState<'open' | 'overdue' | 'mine' | 'all'>('open')

  const { data, error, loading, reload } = useAsync(async () => {
    const [incidents, agents, profiles, sla] = await Promise.all([api.incidents(), api.agents(), api.allProfiles(), api.incidentSla()])
    return {
      incidents: sortIncidents(incidents),
      agents: new Map(agents.map((a) => [a.id, a])),
      people: new Map(profiles.map((p) => [p.id, p.full_name])),
      sla,
    }
  })
  const now = Date.now()
  const counts = useMemo(() => {
    const list = data?.incidents ?? []
    return {
      open: list.filter(isOpen).length,
      overdue: list.filter((i) => incidentDue(i, now)?.overdue).length,
      mine: list.filter((i) => isOpen(i) && i.owner_id === me).length,
      all: list.length,
    }
  }, [data, me, now])
  const rows = (data?.incidents ?? []).filter((i) =>
    show === 'all' ? true : show === 'open' ? isOpen(i) : show === 'mine' ? isOpen(i) && i.owner_id === me : incidentDue(i, now)?.overdue)
  const name = (id: string | null) => (id ? data?.people.get(id) ?? 'Former user' : null)

  return (
    <div className="space-y-5">
      <PageHeader title="Incidents" subtitle="Opened when an agent is suspended, or reported by an agent or a connected system" />
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Open" value={counts.open} tone={counts.open ? 'warn' : undefined} onClick={() => setShow('open')} active={show === 'open'} />
          <Stat label="Overdue" value={counts.overdue} tone={counts.overdue ? 'bad' : undefined} onClick={() => setShow('overdue')} active={show === 'overdue'} />
          <Stat label="Open, owned by me" value={counts.mine} onClick={() => setShow('mine')} active={show === 'mine'} />
          <Stat label="All incidents" value={counts.all} onClick={() => setShow('all')} active={show === 'all'} />
        </div>
      )}
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}
      {data && rows.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          {data.incidents.length === 0 ? 'No incidents yet.' : 'No incidents match.'}
        </div>
      )}
      {data && rows.length > 0 && <IncidentList incidents={rows} agents={data.agents} name={name} now={now} />}
      {data && <DriftList agents={data.agents} limit={50} />}
      {data && <IncidentTimeLimits settings={data.sla} canEdit={hasRole('admin')} onSaved={reload} />}
    </div>
  )
}

function Stat({ label, value, tone, onClick, active }: {
  label: string; value: number; tone?: 'bad' | 'warn'; onClick: () => void; active: boolean
}) {
  const color = tone === 'bad' ? 'text-red-700 dark:text-red-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`bg-card rounded-lg border p-3 text-left transition hover:shadow-sm ${active ? 'ring-brand-yellow ring-2' : ''}`}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </button>
  )
}

/** Time to resolve for each severity, in hours. Everyone sees it; admins change it. */
function IncidentTimeLimits({ settings, canEdit, onSaved }: { settings: IncidentSla[]; canEdit: boolean; onSaved: () => Promise<void> }) {
  const hours = (s: RiskTier) => String((settings.find((x) => x.severity === s)?.minutes ?? 0) / 60)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(SEVERITIES.map((s) => [s, hours(s)])))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const changed = SEVERITIES.filter((s) => values[s] !== hours(s))

  async function save(e: FormEvent) {
    e.preventDefault()
    const bad = changed.find((s) => !/^\d+$/.test(values[s]) || Number(values[s]) < 1 || Number(values[s]) > 720)
    if (bad) { setMsg({ ok: false, text: `${RISK_LABEL[bad]}: enter whole hours from 1 to 720.` }); return }
    setBusy(true); setMsg(null)
    try {
      for (const s of changed) await api.saveIncidentSla(s, Number(values[s]) * 60)
      await onSaved()
      setMsg({ ok: true, text: 'Saved. New incidents use these times.' })
    } catch (err) { setMsg({ ok: false, text: errorMessage(err) }) } finally { setBusy(false) }
  }

  return (
    <section className="bg-card space-y-3 rounded-lg border p-4" data-testid="incident-time-limits">
      <div>
        <h2 className="font-semibold">Time to resolve, by severity</h2>
        <p className="text-muted-foreground text-xs">
          A new incident must be resolved within this time. An incident opened by a suspension takes the agent's risk tier as its severity.
        </p>
      </div>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-4">
        {SEVERITIES.map((s) => (
          <div key={s} className="space-y-1">
            <Label htmlFor={`isla-${s}`}>{RISK_LABEL[s]} (hours)</Label>
            <Input id={`isla-${s}`} inputMode="numeric" disabled={!canEdit} value={values[s]} onChange={(e) => setValues({ ...values, [s]: e.target.value })} />
            {/^\d+$/.test(values[s]) && Number(values[s]) > 0 && <p className="text-muted-foreground text-xs">= {durationText(Number(values[s]) * 60)}</p>}
          </div>
        ))}
        {canEdit && (
          <div className="flex items-center gap-3 sm:col-span-4">
            <Button type="submit" variant="outline" disabled={busy || changed.length === 0}>Save times</Button>
            {msg && <span role="status" className={msg.ok ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-destructive text-sm'}>{msg.text}</span>}
          </div>
        )}
      </form>
    </section>
  )
}
