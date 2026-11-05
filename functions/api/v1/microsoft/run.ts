import { json, problem } from '../../../../functions-lib/api'
import { runMicrosoftChecks } from '../../../../functions-lib/microsoft'

/**
 * POST /api/v1/microsoft/run   body: { "token": "mct_..." }
 * Task 3.1. Called by the database (pg_net) when an admin presses "Run Microsoft checks". The token is single-use and
 * only the database can make one. Answers at once and works in the background; the results go back to the database.
 */
export async function onRequestPost({ request, waitUntil }: { request: Request; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!/^mct_[0-9a-f]{64}$/.test(token)) return problem(400, 'invalid_request', 'Send {"token": "..."} from the database.')
  waitUntil(runMicrosoftChecks(token).catch(() => undefined))
  return json(202, { accepted: true })
}
