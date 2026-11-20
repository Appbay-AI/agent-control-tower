// Task 6.1 (R5.5): the evidence pack. Pick a date range, one click, a PDF: inventory, approvals, incidents, autonomy
// changes, reviews, kill-switch events, drift, re-quarantine actions, sync history and an attestation.
// Task 6.2: the same pack as an Excel file. Downloading the other format for the same dates reuses the pack just made
// (same audit entry, same digest), so the two files match.
// 20 Nov: an Agent filter. With an agent chosen, the PDF and the Excel file hold only that agent's records.
import { FileDown, FileSpreadsheet, ShieldCheck, ShieldAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ErrorBox, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { day, downloadEvidencePdf, evidenceFileName, packAgent, SECTIONS, sectionCounts, when, type EvidencePack } from '@/lib/evidence'
import { downloadEvidenceExcel, evidenceExcelName } from '@/lib/evidenceExcel'
import { errorMessage } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const ago = (days: number) => iso(new Date(Date.now() - days * 86_400_000))

/** Quick ranges, all ending today (UTC). */
export function quickRanges(today = new Date()): { label: string; from: string; to: string }[] {
  const t = iso(today)
  const y = today.getUTCFullYear()
  const q = Math.floor(today.getUTCMonth() / 3)
  const lastQ = q === 0 ? { y: y - 1, q: 3 } : { y, q: q - 1 }
  const qStart = iso(new Date(Date.UTC(lastQ.y, lastQ.q * 3, 1)))
  const qEnd = iso(new Date(Date.UTC(lastQ.y, lastQ.q * 3 + 3, 0)))
  return [
    { label: 'Last 30 days', from: iso(new Date(today.getTime() - 29 * 86_400_000)), to: t },
    { label: 'Last 90 days', from: iso(new Date(today.getTime() - 89 * 86_400_000)), to: t },
    { label: `Q${lastQ.q + 1} ${lastQ.y}`, from: qStart, to: qEnd },
    { label: `${y} so far`, from: `${y}-01-01`, to: t },
  ]
}

export function EvidencePage() {
  const [from, setFrom] = useState(ago(89))
  const [to, setTo] = useState(iso(new Date()))
  const [agent, setAgent] = useState('')
  const agents = useAsync(() => api.agentChoices())
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<EvidencePack | null>(null)
  const [files, setFiles] = useState<string[]>([])

  async function make(format: 'pdf' | 'xlsx', e?: FormEvent) {
    e?.preventDefault()
    if (!from || !to) { setError('Choose a start and an end date.'); return }
    if (from > to) { setError('Choose a start date on or before the end date.'); return }
    setBusy(format); setError(null)
    try {
      // The same dates and agent as the pack just made: the same pack, so the PDF and the Excel file match.
      const same = made && made.period.from === from && made.period.to === to && (made.agent?.id ?? '') === agent
      performance.mark('act:evidence-start')
      const pack = same ? made : await api.evidencePack(from, to, agent || null)
      // Where the time goes (the browser test reads these when a download is slow).
      performance.mark('act:evidence-data')
      if (format === 'pdf') await downloadEvidencePdf(pack)
      else await downloadEvidenceExcel(pack)
      performance.mark('act:evidence-file')
      setMade(pack)
      const name = format === 'pdf' ? evidenceFileName(pack) : evidenceExcelName(pack)
      setFiles((f) => (same ? [...f.filter((x) => x !== name), name] : [name]))
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(null) }
  }
  const reset = () => { setMade(null); setFiles([]) }

  const counts = made ? sectionCounts(made) : null
  return (
    <div className="space-y-6">
      <PageHeader title="Evidence pack"
        subtitle="Everything an auditor needs for a period, as one PDF: the agents, who approved what, incidents, autonomy changes, reviews, kill-switch events, drift, re-quarantine actions, sync history, and proof the audit trail is intact. Dates are whole days in UTC." />

      <form onSubmit={(e) => make('pdf', e)} className="bg-card space-y-4 rounded-lg border p-4" noValidate>
        <div className="flex flex-wrap gap-2">
          {quickRanges().map((r) => (
            <Button key={r.label} type="button" size="sm" variant={from === r.from && to === r.to ? 'default' : 'outline'}
              onClick={() => { setFrom(r.from); setTo(r.to); reset() }}>{r.label}</Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[12rem_12rem_minmax(14rem,20rem)_auto_auto] lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="ev-from">From</Label>
            <Input id="ev-from" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); reset() }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-to">To (including)</Label>
            <Input id="ev-to" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); reset() }} />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
            <Label htmlFor="ev-agent">Agent</Label>
            <select id="ev-agent" className={selectClass + ' w-full'} value={agent} onChange={(e) => { setAgent(e.target.value); reset() }}>
              <option value="">All agents</option>
              {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.agent_code} {a.name}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={busy !== null}><FileDown /> {busy === 'pdf' ? 'Making the PDF…' : 'Download PDF'}</Button>
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => make('xlsx')}>
            <FileSpreadsheet /> {busy === 'xlsx' ? 'Making the Excel file…' : 'Download Excel'}
          </Button>
        </div>
        <ErrorBox message={error} />
      </form>

      {made && counts && (
        <section className="bg-card space-y-3 rounded-lg border p-4 text-sm" data-testid="evidence-made" role="status">
          <h2 className="font-semibold">Downloaded {files.join(' and ')}</h2>
          <p className="text-muted-foreground">
            {day(made.period.from)} to {day(made.period.to)}{packAgent(made) ? `, for ${packAgent(made)} only` : ', all agents'}, produced {when(made.generated.at)} UTC and recorded in the audit trail as entry #{made.attestation.pack_seq}.
            {files.length === 1 && ' Download the other format now for the same pack, with the same entry and digest.'}
          </p>
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2" data-testid="evidence-counts">
            {SECTIONS.map(([k, title], i) => (
              <li key={k} className="flex justify-between gap-4 border-b py-1"><span>{i + 1}. {title}</span><span className="tabular-nums">{counts[k].toLocaleString('en-GB')}</span></li>
            ))}
          </ul>
          <p className={made.attestation.chain_intact ? 'flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400' : 'flex items-center gap-2 font-medium text-red-700 dark:text-red-400'}
            data-testid="evidence-chain">
            {made.attestation.chain_intact
              ? <><ShieldCheck className="size-4" /> Audit trail intact: all {made.attestation.chain_length.toLocaleString('en-GB')} entries checked.</>
              : <><ShieldAlert className="size-4" /> Audit trail broken at entry #{made.attestation.chain_broken_at}.</>}
          </p>
          <p className="text-muted-foreground font-mono text-xs break-all">SHA-256 of the pack's data: {made.attestation.digest}</p>
        </section>
      )}
    </div>
  )
}
