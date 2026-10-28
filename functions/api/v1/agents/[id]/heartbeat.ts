import { bearer, problem, rpc, json, type Ctx } from '../../../../../functions-lib/api'

interface Beat {
  agent_id: string; agent_code: string; status: string; may_act: boolean
  heard_at: string; silent_after_minutes: number | null; check_in_by: string | null
}

/**
 * POST /api/v1/agents/{id}/heartbeat   ({id} = agent id or code, e.g. AGT-0001)
 * Authorization: Bearer <agent key>
 * Body (optional): { "note": "Queue: 12 invoices" }   (up to 500 characters, shown on the agent's page)
 *
 * The agent checks in. Answers whether it may act, and by when it must check in next if it is watched for silence
 * (check_in_by; null when not watched). Any call with the key also counts as being heard from.
 */
export async function onRequestPost({ request, params }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send the agent key as "Authorization: Bearer <key>".')
  const text = await request.text()
  let note: unknown = null
  if (text.trim()) {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return problem(400, 'invalid_json', 'The request body must be JSON (or empty).')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(400, 'invalid_json', 'The request body must be a JSON object.')
    note = (body as Record<string, unknown>).note ?? null
    if (note !== null && typeof note !== 'string') return problem(422, 'invalid_request', 'note must be text.')
  }
  const result = await rpc<Beat>('api_agent_heartbeat', { p_agent_key: key, p_agent: String(params.id), p_note: note })
  if (!result.ok) return result.response
  return json(200, result.data)
}
