import { json, problem } from '../../../../functions-lib/api'
import { runEnforcement } from '../../../../functions-lib/enforce'

/**
 * POST /api/v1/enforce/run   body: { "token": "ent_..." }
 * Task 4.2. Called by the database (pg_net) when a suspended agent has to be stopped: blocked on its platform, sent a stop
 * request, or its owner emailed. The token is single-use and only the database can make one. Answers at once and works in
 * the background; what happened goes back to the database, where the agent's page shows it.
 */
export async function onRequestPost({ request, waitUntil }: { request: Request; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!/^ent_[0-9a-f]{64}$/.test(token)) return problem(400, 'invalid_request', 'Send {"token": "..."} from the database.')
  waitUntil(runEnforcement(token).catch(() => undefined))
  return json(202, { accepted: true })
}
