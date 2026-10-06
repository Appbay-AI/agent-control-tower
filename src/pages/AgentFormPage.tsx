import { ArrowLeft } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBox, LoadingRows, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AUTONOMY, DATA_LABEL, errorMessage, FRAMEWORK_LABEL, parseList, REGULATORY_FLAGS, RISK_LABEL } from '@/lib/format'
import type { Agent, AgentDraft, DataClassification } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export function emptyDraft(userId: string): AgentDraft {
  return {
    name: '', description: null, version: null, origin: 'internal', vendor_name: null, framework: 'other',
    business_owner_id: userId, technical_owner_id: null, department_id: null, cost_centre: null,
    purpose_statement: '', in_scope_actions: [], out_of_scope_actions: [],
    systems_accessed: [], data_classifications: [], credential_type: null, credential_owner: null,
    autonomy_level: 1, value_threshold: null, threshold_currency: 'GBP', volume_threshold: null,
    risk_tier: 'medium', regulatory_flags: [], control_endpoint: null,
  }
}

export function draftFromAgent(a: Agent): AgentDraft {
  const { name, description, version, origin, vendor_name, framework, business_owner_id, technical_owner_id,
    department_id, cost_centre, purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed,
    data_classifications, credential_type, credential_owner, autonomy_level, value_threshold, threshold_currency,
    volume_threshold, risk_tier, regulatory_flags, control_endpoint } = a
  return { name, description, version, origin, vendor_name, framework, business_owner_id, technical_owner_id,
    department_id, cost_centre, purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed,
    data_classifications, credential_type, credential_owner, autonomy_level, value_threshold, threshold_currency,
    volume_threshold, risk_tier, regulatory_flags, control_endpoint }
}

/** Client-side checks that mirror the database constraints, so people see problems before saving. */
export function validateDraft(d: AgentDraft): string | null {
  if (!d.name.trim()) return 'Give the agent a name.'
  if (d.origin === 'vendor' && !d.vendor_name?.trim()) return 'Name the vendor for a vendor agent.'
  if (d.autonomy_level === 3 && d.value_threshold === null && d.volume_threshold === null)
    return 'A Level 3 agent needs a value or volume limit: it acts alone only below it.'
  if (d.value_threshold !== null && d.value_threshold < 0) return 'The value limit cannot be negative.'
  if (d.volume_threshold !== null && d.volume_threshold < 0) return 'The volume limit cannot be negative.'
  return null
}

const nullIfBlank = (s: string) => (s.trim() === '' ? null : s)
const numberOrNull = (s: string) => (s.trim() === '' ? null : Number(s))

export function AgentFormPage() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const { session } = useAuth()
  const navigate = useNavigate()
  const userId = session!.user.id

  const [draft, setDraft] = useState<AgentDraft | null>(isEdit ? null : emptyDraft(userId))
  const [lists, setLists] = useState({ inScope: '', outScope: '', systems: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const lookups = useAsync(async () => {
    const [departments, profiles, agent] = await Promise.all([api.departments(), api.profiles(), id ? api.agent(id) : null])
    if (agent) {
      setDraft(draftFromAgent(agent))
      setLists({ inScope: agent.in_scope_actions.join('\n'), outScope: agent.out_of_scope_actions.join('\n'), systems: agent.systems_accessed.join('\n') })
    }
    return { departments, profiles, agent }
  }, [id])

  if (lookups.error) return <ErrorBox message={lookups.error} />
  if (!draft || !lookups.data) return <LoadingRows rows={6} />
  const { departments, profiles, agent } = lookups.data
  if (agent && agent.status !== 'proposed') {
    return <ErrorBox message={`${agent.agent_code} is ${agent.status}. Only Proposed agents can be edited; changes to approved agents go through review.`} />
  }

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft({ ...draft, [key]: value })
  const toggle = <T extends string>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const full: AgentDraft = {
      ...draft!,
      in_scope_actions: parseList(lists.inScope),
      out_of_scope_actions: parseList(lists.outScope),
      systems_accessed: parseList(lists.systems),
    }
    const problem = validateDraft(full)
    if (problem) { setError(problem); return }
    setBusy(true)
    setError(null)
    try {
      const saved = isEdit ? await api.updateAgent(id!, full) : await api.createAgent(full, userId)
      navigate(`/agents/${saved.id}`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl space-y-6">
      <Link to={isEdit ? `/agents/${id}` : '/agents'} className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft className="size-4" /> Back
      </Link>
      <PageHeader title={isEdit ? `Edit ${agent?.agent_code}` : 'Register an agent'}
        subtitle="The agent is saved as Proposed. It cannot act until it is approved and put live." />

      <Section title="Identity">
        <Row label="Name" htmlFor="name" required>
          <Input id="name" required value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Row>
        <Row label="Description" htmlFor="description">
          <Textarea id="description" rows={2} value={draft.description ?? ''} onChange={(e) => set('description', nullIfBlank(e.target.value))} />
        </Row>
        <div className="grid gap-4 sm:grid-cols-3">
          <Row label="Built by" htmlFor="origin">
            <select id="origin" className={selectClass} value={draft.origin} onChange={(e) => set('origin', e.target.value as AgentDraft['origin'])}>
              <option value="internal">Internal team</option>
              <option value="vendor">Vendor</option>
            </select>
          </Row>
          <Row label="Framework" htmlFor="framework">
            <select id="framework" className={selectClass} value={draft.framework} onChange={(e) => set('framework', e.target.value as AgentDraft['framework'])}>
              {Object.entries(FRAMEWORK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          <Row label="Version" htmlFor="version">
            <Input id="version" value={draft.version ?? ''} onChange={(e) => set('version', nullIfBlank(e.target.value))} />
          </Row>
        </div>
        {draft.origin === 'vendor' && (
          <Row label="Vendor" htmlFor="vendor" required>
            <Input id="vendor" value={draft.vendor_name ?? ''} onChange={(e) => set('vendor_name', nullIfBlank(e.target.value))} />
          </Row>
        )}
      </Section>

      <Section title="Ownership" hint="An agent needs a named business owner before it can be submitted.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Row label="Business owner" htmlFor="bo" required>
            <select id="bo" className={selectClass} value={draft.business_owner_id ?? ''} onChange={(e) => set('business_owner_id', e.target.value || null)}>
              <option value="">— Not assigned —</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.job_title ? ` · ${p.job_title}` : ''}</option>)}
            </select>
          </Row>
          <Row label="Technical owner" htmlFor="to">
            <select id="to" className={selectClass} value={draft.technical_owner_id ?? ''} onChange={(e) => set('technical_owner_id', e.target.value || null)}>
              <option value="">— Not assigned —</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </Row>
          <Row label="Department" htmlFor="dept" required>
            <select id="dept" className={selectClass} value={draft.department_id ?? ''} onChange={(e) => set('department_id', e.target.value || null)}>
              <option value="">— Choose —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Row>
          <Row label="Cost centre" htmlFor="cc">
            <Input id="cc" value={draft.cost_centre ?? ''} onChange={(e) => set('cost_centre', nullIfBlank(e.target.value))} />
          </Row>
        </div>
      </Section>

      <Section title="Purpose" hint="The single business reason this agent exists. Actions outside it are breaches.">
        <Row label="Purpose statement" htmlFor="purpose" required>
          <Textarea id="purpose" rows={3} value={draft.purpose_statement} onChange={(e) => set('purpose_statement', e.target.value)} />
        </Row>
        <div className="grid gap-4 sm:grid-cols-2">
          <Row label="Allowed actions" htmlFor="in" hint="One per line">
            <Textarea id="in" rows={4} value={lists.inScope} onChange={(e) => setLists({ ...lists, inScope: e.target.value })} />
          </Row>
          <Row label="Forbidden actions" htmlFor="out" hint="One per line">
            <Textarea id="out" rows={4} value={lists.outScope} onChange={(e) => setLists({ ...lists, outScope: e.target.value })} />
          </Row>
        </div>
      </Section>

      <Section title="Access">
        <Row label="Systems it touches" htmlFor="systems" hint="One per line, e.g. SAP, Salesforce">
          <Textarea id="systems" rows={3} value={lists.systems} onChange={(e) => setLists({ ...lists, systems: e.target.value })} />
        </Row>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Data it touches</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(DATA_LABEL) as DataClassification[]).map((c) => (
              <Chip key={c} on={draft.data_classifications.includes(c)} onClick={() => set('data_classifications', toggle(draft.data_classifications, c))}>
                {DATA_LABEL[c]}
              </Chip>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Row label="Credential type" htmlFor="ct" hint="e.g. Service account, OAuth client">
            <Input id="ct" value={draft.credential_type ?? ''} onChange={(e) => set('credential_type', nullIfBlank(e.target.value))} />
          </Row>
          <Row label="Credential owner" htmlFor="co">
            <Input id="co" value={draft.credential_owner ?? ''} onChange={(e) => set('credential_owner', nullIfBlank(e.target.value))} />
          </Row>
        </div>
      </Section>

      <Section title="Autonomy" hint="How much the agent may do on its own.">
        <div className="grid gap-2 sm:grid-cols-2">
          {([1, 2, 3, 4] as const).map((level) => (
            <label key={level}
              className={`cursor-pointer rounded-lg border p-3 ${draft.autonomy_level === level ? 'border-brand-charcoal ring-brand-yellow ring-2 dark:border-brand-yellow' : ''}`}>
              <input type="radio" name="autonomy" className="sr-only" checked={draft.autonomy_level === level}
                onChange={() => set('autonomy_level', level)} />
              <div className="text-sm font-medium">Level {level} · {AUTONOMY[level].name}</div>
              <div className="text-muted-foreground text-xs">{AUTONOMY[level].text}</div>
            </label>
          ))}
        </div>
        {draft.autonomy_level >= 3 && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Row label="Value limit per action" htmlFor="vt" required={draft.autonomy_level === 3 && draft.volume_threshold === null}>
              <Input id="vt" type="number" min={0} step="0.01" value={draft.value_threshold ?? ''}
                onChange={(e) => set('value_threshold', numberOrNull(e.target.value))} />
            </Row>
            <Row label="Currency" htmlFor="cur">
              <select id="cur" className={selectClass} value={draft.threshold_currency} onChange={(e) => set('threshold_currency', e.target.value)}>
                {['GBP', 'EUR', 'USD', 'AED', 'SAR', 'INR'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </Row>
            <Row label="Actions per day limit" htmlFor="vol">
              <Input id="vol" type="number" min={0} step="1" value={draft.volume_threshold ?? ''}
                onChange={(e) => set('volume_threshold', numberOrNull(e.target.value))} />
            </Row>
          </div>
        )}
      </Section>

      <Section title="Risk">
        <Row label="Risk tier" htmlFor="risk" hint="Critical agents need two approvers.">
          <select id="risk" className={`${selectClass} sm:w-48`} value={draft.risk_tier} onChange={(e) => set('risk_tier', e.target.value as AgentDraft['risk_tier'])}>
            {Object.entries(RISK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Regulations that apply</legend>
          <div className="flex flex-wrap gap-2">
            {REGULATORY_FLAGS.map((f) => (
              <Chip key={f} on={draft.regulatory_flags.includes(f)} onClick={() => set('regulatory_flags', toggle(draft.regulatory_flags, f))}>{f}</Chip>
            ))}
          </div>
        </fieldset>
        <Row label="Control endpoint" htmlFor="ep" hint="Where the stop signal is sent if the agent is suspended (used in Phase 3).">
          <Input id="ep" type="url" placeholder="https://" value={draft.control_endpoint ?? ''}
            onChange={(e) => set('control_endpoint', nullIfBlank(e.target.value))} />
        </Row>
      </Section>

      <ErrorBox message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Save as Proposed'}</Button>
        <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
      </div>
    </form>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-4 rounded-lg border p-4 sm:p-5">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, htmlFor, hint, required, children }: {
  label: string; htmlFor: string; hint?: string; required?: boolean; children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}{required && <span className="text-red-600"> *</span>}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs ${on ? 'bg-brand-charcoal border-brand-charcoal text-white dark:bg-brand-yellow dark:text-brand-charcoal' : 'hover:bg-muted'}`}>
      {children}
    </button>
  )
}
