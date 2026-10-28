import { bearer, problem, rpc, json, type Ctx } from '../../../../../functions-lib/api'

interface Accepted { agent_id: string; agent_code: string; accepted: number; duplicates: number; may_act: boolean }

/**
 * POST /api/v1/agents/{id}/logs   ({id} = agent id or code, e.g. AGT-0001)
 * Authorization: Bearer <agent key>
 * Body: one entry, or { "entries": [ ...up to 100 ] }. An entry:
 *   { "message": "...", "level": "debug" | "info" | "warning" | "error", "event": "invoice.matched",
 *     "occurred_at": "2026-10-28T09:15:00Z", "request": "REQ-000123", "details": { ... }, "id": "your-own-id" }
 * Only message is required. A batch is stored whole or not at all; an entry whose id was sent before is skipped,
 * so retrying is safe. Answers 201 with how many were stored. Entries can never be edited or deleted; kept 90 days.
 */
export async function onRequestPost({ request, params }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send the agent key as "Authorization: Bearer <key>".')
  if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) {
    return problem(413, 'too_large', 'Send at most 1 MB at a time.')
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return problem(400, 'invalid_json', 'The request body must be JSON.')
  }
  if (!body || typeof body !== 'object') return problem(400, 'invalid_json', 'Send one log entry, or { "entries": [ ... ] }.')
  const entries = Array.isArray(body) ? body : 'entries' in body ? (body as { entries: unknown }).entries : body
  if (!entries || typeof entries !== 'object') return problem(422, 'invalid_request', 'entries must be a list of log entries.')
  const result = await rpc<Accepted>('api_agent_log', { p_agent_key: key, p_agent: String(params.id), p_entries: entries })
  if (!result.ok) return result.response
  return json(201, result.data)
}
