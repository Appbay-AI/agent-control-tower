import { json, problem } from '../../../../functions-lib/api'
import { runPlatformJob } from '../../../../functions-lib/platforms/run'

/**
 * POST /api/v1/platforms/run   body: { "token": "pjt_..." }
 * Task 3.2. Called by the database (pg_net) when an admin starts a platform job such as "Test connection". The token is
 * single-use and only the database can make one, so this endpoint needs no other secret. Answers at once and works in
 * the background; the result goes back to the database, where the page reads it.
 */
export async function onRequestPost({ request, waitUntil }: { request: Request; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!/^pjt_[0-9a-f]{64}$/.test(token)) return problem(400, 'invalid_request', 'Send {"token": "..."} from the database.')
  waitUntil(runPlatformJob(token).catch(() => undefined))
  return json(202, { accepted: true })
}
