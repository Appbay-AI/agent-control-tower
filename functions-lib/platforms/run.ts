// Task 3.2: runs one platform job handed over by the database (see migration 20261101000100_platform_connections.sql).
import { rpc } from '../api'
import { PlatformError, pluginFor, type PlatformConnection } from './index'

interface Claimed { job: number; kind: string; connection: PlatformConnection & { name: string } }
export interface JobOutcome { ok: boolean; message: string; result: Record<string, unknown> | null }

/** "Test connection": can we sign in and list the agents? Says how many, and how many are blocked or have no owner. */
async function check(connection: Claimed['connection'], fetchImpl: typeof fetch): Promise<JobOutcome> {
  const plugin = pluginFor(connection, fetchImpl)
  const agents = await plugin.listAgents()
  const blocked = agents.filter((a) => a.status === 'blocked').length
  const ownerless = agents.filter((a) => a.owner === null).length
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  return {
    ok: true,
    message: `Connected to ${plugin.label}: ${plural(agents.length, 'agent')} found` +
      (blocked || ownerless ? ` (${[blocked && `${blocked} blocked`, ownerless && `${ownerless} without an owner`].filter(Boolean).join(', ')})` : ''),
    result: { agents: agents.length, blocked, ownerless, names: agents.slice(0, 20).map((a) => `${a.externalId} ${a.name}`) },
  }
}

export async function runPlatformJob(token: string, fetchImpl: typeof fetch = fetch): Promise<JobOutcome | null> {
  const claimed = await rpc<Claimed>('platform_job_claim', { p_token: token }, fetchImpl)
  if (!claimed.ok) return null
  const { kind, connection } = claimed.data
  let outcome: JobOutcome
  try {
    if (kind !== 'check') throw new PlatformError('refused', `Unknown job kind "${kind}".`)
    outcome = await check(connection, fetchImpl)
  } catch (e) {
    const err = e instanceof PlatformError ? e : new PlatformError('unreachable', `Unexpected error: ${(e as Error).message}`)
    outcome = { ok: false, message: err.message, result: { error: err.code, http_status: err.httpStatus } }
  }
  await rpc('platform_job_report', { p_token: token, p_ok: outcome.ok, p_message: outcome.message, p_result: outcome.result }, fetchImpl)
  return outcome
}
