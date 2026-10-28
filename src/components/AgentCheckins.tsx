// Task 2.11: on the agent's page, when it was last heard from, the silent-agent limit, and its log.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, Field, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { durationText } from '@/lib/sla'
import { formatDateTime, errorMessage } from '@/lib/format'
import { heardAgo, LEVEL_LABEL, LEVEL_STYLE, silenceChoices, silenceLimitText, watchState } from '@/lib/checkins'
import type { AgentContact, AgentLog } from '@/lib/types'

export function CheckinsBody({ limit, contact, live, canChange, onSave }: {
  limit: number | null; contact: AgentContact | null; live: boolean; canChange: boolean
  onSave: (minutes: number | null) => Promise<void>
}) {
  const [choice, setChoice] = useState(limit === null ? '' : String(limit))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const watch = watchState(limit, contact, live)
  const changed = choice !== (limit === null ? '' : String(limit))

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await onSave(choice === '' ? null : Number(choice))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dl className="space-y-3">
      <Field label="Last heard from">
        <span data-testid="last-heard">
          {heardAgo(contact?.last_seen_at)}
          {contact?.last_seen_at && <span className="text-muted-foreground text-xs"> · {formatDateTime(contact.last_seen_at)} · {contact.last_seen_via}</span>}
        </span>
        {contact?.last_note && <div className="text-muted-foreground text-xs">Last check-in: “{contact.last_note}”</div>}
      </Field>
      <Field label="Silent-agent check">
        <div data-testid="silence-limit">{silenceLimitText(limit)}</div>
        <div data-testid="watch-state"
          className={`text-xs ${watch.tone === 'late' ? 'font-medium text-red-700 dark:text-red-400' : 'text-muted-foreground'}`}>
          {watch.text}
        </div>
      </Field>
      {canChange && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select className={`${selectClass} flex-1`} value={choice} onChange={(e) => setChoice(e.target.value)}
              aria-label="Flag if silent for more than">
              <option value="">Not watched</option>
              {silenceChoices(limit).map((m) => <option key={m} value={m}>Silent for more than {durationText(m)}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={busy || !changed} onClick={save}>Save</Button>
          </div>
          <ErrorBox message={error} />
        </div>
      )}
      <p className="text-muted-foreground text-xs">Any call the agent makes with its key counts: checking in, writing to its log, asking before acting.</p>
    </dl>
  )
}

export function AgentLogList({ entries }: { entries: AgentLog[] }) {
  if (!entries.length) {
    return <p className="text-muted-foreground text-sm">Nothing yet. The agent writes here through the log API (POST /api/v1/agents/&#123;id&#125;/logs).</p>
  }
  return (
    <ol className="space-y-2" data-testid="agent-log">
      {entries.map((e) => (
        <li key={e.id} className="border-l-2 pl-3 text-sm" data-testid="log-entry">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${LEVEL_STYLE[e.level]}`}>{LEVEL_LABEL[e.level]}</span>
            <span className="break-words">{e.message}</span>
          </div>
          <div className="text-muted-foreground text-xs">
            {formatDateTime(e.occurred_at)}
            {e.event && <> · <code>{e.event}</code></>}
            {e.request && <> · <Link className="hover:underline" to={`/approvals/requests/${e.request_id}`}>{e.request.request_code}</Link></>}
          </div>
          {e.details && Object.keys(e.details).length > 0 && (
            <details className="text-xs">
              <summary className="text-muted-foreground cursor-pointer">Details</summary>
              <pre className="bg-muted mt-1 overflow-x-auto rounded p-2">{JSON.stringify(e.details, null, 2)}</pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  )
}
