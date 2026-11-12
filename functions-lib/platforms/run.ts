// Tasks 3.2 and 3.3: runs one platform job handed over by the database (migrations 20261101000100_platform_connections.sql
// and 20261102000100_platform_sync.sql): 'check' (Test connection), 'sync' (fetch the agent list and store it) or, task 4.7,
// 'reconcile' (read suspended agents' status; see 20261114000100_reconciliation.sql).
import { rpc } from '../api'
import { PlatformError, pluginFor, type PlatformConnection } from './index'

interface Target { platform_agent_id: string; external_id: string; agent_code: string }
interface Claimed { job: number; kind: string; connection: PlatformConnection & { name: string }; targets?: Target[] | null }
export interface JobOutcome { ok: boolean; message: string; result: Record<string, unknown> | null }

/** "Test connection": can we sign in and list the agents? Says how many, and how many are blocked or have no owner. */
async function check(connection: Claimed['connection'], fetchImpl: typeof fetch): Promise<JobOutcome> {
  const plugin = pluginFor(connection, fetchImpl)
  const agents = await plugin.listAgents()
  const blocked = agents.filter((a) => a.status === 'blocked').length
  const ownerless = agents.filter((a) => a.owner === null).length
  return {
    ok: true,
    message: `Connected to ${plugin.label}: ${plural(agents.length, 'agent')} found` +
      (blocked || ownerless ? ` (${[blocked && `${blocked} blocked`, ownerless && `${ownerless} without an owner`].filter(Boolean).join(', ')})` : ''),
    result: { agents: agents.length, blocked, ownerless, names: agents.slice(0, 20).map((a) => `${a.externalId} ${a.name}`) },
  }
}

interface SyncCounts { agents: number; new: number; status_changed: number; back: number; missing: number; blocked: number; registered?: number; linked?: number }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** "Sync": list every agent and hand the list to the database, which works out what is new, changed or missing. */
async function sync(token: string, connection: Claimed['connection'], fetchImpl: typeof fetch): Promise<JobOutcome> {
  const plugin = pluginFor(connection, fetchImpl)
  const agents = await plugin.listAgents()
  const stored = await rpc<SyncCounts>('platform_sync_apply', { p_token: token, p_agents: agents }, fetchImpl)
  if (!stored.ok) {
    const body = (await stored.response.json().catch(() => null)) as { message?: string } | null
    return { ok: false, message: `The agent list could not be stored: ${body?.message ?? `HTTP ${stored.response.status}`}`, result: { error: 'store_failed' } }
  }
  const c = stored.data
  const changes = [c.new && `${c.new} new`, c.status_changed && `${plural(c.status_changed, 'status change')}`,
    c.missing && `${c.missing} missing at source`, c.back && `${c.back} back`,
    c.registered && `${c.registered} added to the registry as Discovered`, c.linked && `${c.linked} linked to the registry`].filter(Boolean)
  return {
    ok: true,
    message: `Synced ${plural(c.agents, 'agent')} from ${plugin.label}: ${changes.length ? changes.join(', ') : 'no changes'}`,
    result: { ...c },
  }
}

/**
 * Task 4.7, "reconcile": read the status of each suspended agent the platform had confirmed as blocked. The database
 * blocks again, records, raises a Critical incident and alerts admins for any that reads active (switched back on
 * outside Control Tower). An agent that cannot be read this time is left for the next cycle.
 */
async function reconcile(token: string, connection: Claimed['connection'], targets: Target[], fetchImpl: typeof fetch): Promise<JobOutcome> {
  const plugin = pluginFor(connection, fetchImpl)
  const read = await Promise.all(targets.map(async (t) => {
    try {
      const s = await plugin.readStatus(t.external_id)
      return { platform_agent_id: t.platform_agent_id, status: s.status as string }
    } catch (e) {
      return { platform_agent_id: t.platform_agent_id, status: e instanceof PlatformError && e.code === 'not_found' ? 'missing' : 'unreadable',
        error: (e as Error).message }
    }
  }))
  const stored = await rpc<{ checked: number; reblocked: number; agents: string[] }>('platform_reconcile_apply', { p_token: token, p_results: read }, fetchImpl)
  if (!stored.ok) {
    const body = (await stored.response.json().catch(() => null)) as { message?: string } | null
    return { ok: false, message: `The statuses could not be stored: ${body?.message ?? `HTTP ${stored.response.status}`}`, result: { error: 'store_failed' } }
  }
  const unreadable = read.filter((r) => r.status === 'unreadable')
  const c = stored.data
  const parts = [`Checked ${plural(c.checked, 'suspended agent')} on ${plugin.label}`,
    c.reblocked ? `${c.agents.join(', ')} switched back on outside Control Tower: blocking again, Critical incident opened` : 'all still blocked',
    ...(unreadable.length ? [`${unreadable.length} could not be read (${unreadable[0].error})`] : [])]
  return { ok: unreadable.length === 0, message: parts.join('; '), result: { ...c, unreadable: unreadable.length } }
}

export async function runPlatformJob(token: string, fetchImpl: typeof fetch = fetch): Promise<JobOutcome | null> {
  const claimed = await rpc<Claimed>('platform_job_claim', { p_token: token }, fetchImpl)
  if (!claimed.ok) return null
  const { kind, connection, targets } = claimed.data
  let outcome: JobOutcome
  try {
    if (kind === 'check') outcome = await check(connection, fetchImpl)
    else if (kind === 'sync') outcome = await sync(token, connection, fetchImpl)
    else if (kind === 'reconcile') outcome = await reconcile(token, connection, targets ?? [], fetchImpl)
    else throw new PlatformError('refused', `Unknown job kind "${kind}".`)
  } catch (e) {
    const err = e instanceof PlatformError ? e : new PlatformError('unreachable', `Unexpected error: ${(e as Error).message}`)
    outcome = { ok: false, message: err.message, result: { error: err.code, http_status: err.httpStatus } }
  }
  await rpc('platform_job_report', { p_token: token, p_ok: outcome.ok, p_message: outcome.message, p_result: outcome.result }, fetchImpl)
  return outcome
}
