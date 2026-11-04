import { bearer, problem, rpc, json, type Ctx } from '../../../functions-lib/api'

interface Opened { duplicate: boolean; incident_code: string }

/**
 * POST /api/v1/incidents   (task 4.4: report an incident)
 * Authorization: Bearer <agent key>        an agent reporting about itself
 *            or: Bearer <integration key>  a connected system reporting about any agent (then "agent" is required)
 * Idempotency-Key: <unique per incident>   (or "idempotency_key" in the body; recommended, so retrying is safe)
 * Body: { title, description?, severity?: low | medium | high | critical (default medium),
 *         agent?: agent id or code (e.g. AGT-0001), occurred_at?: ISO date-time, details?: { ... } }
 *
 * Answers 201 with the new incident (code, owner, severity, time limit and due time), or 200 with the same incident
 * when the idempotency key was used before. Reporting does not by itself suspend the agent.
 */
export async function onRequestPost({ request }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send an agent key or integration key as "Authorization: Bearer <key>".')
  if (Number(request.headers.get('content-length') ?? 0) > 100_000) return problem(413, 'too_large', 'Send at most 100 KB.')
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return problem(400, 'invalid_json', 'The request body must be JSON.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return problem(400, 'invalid_json', 'The request body must be a JSON object.')
  }
  const body = payload as Record<string, unknown>
  const header = request.headers.get('idempotency-key')
  if (header && body.idempotency_key === undefined) body.idempotency_key = header
  if (header && body.idempotency_key !== header) {
    return problem(422, 'invalid_request', 'The Idempotency-Key header and idempotency_key in the body differ.')
  }
  const result = await rpc<Opened>('api_report_incident', { p_key: key, p_payload: body })
  if (!result.ok) return result.response
  return json(result.data.duplicate ? 200 : 201, result.data)
}
