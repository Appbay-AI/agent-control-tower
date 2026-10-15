import { bearer, problem, rpc, json, type Ctx } from '../../../../functions-lib/api'

interface Answer { duplicate: boolean; status: string }

/**
 * POST /api/v1/actions/request
 * Authorization: Bearer <agent key>
 * Idempotency-Key: <unique per request>   (or "idempotency_key" in the body)
 * Body: { action, amount?, currency?, volume?, target_system?, reasoning?, description?, urgency?, details?, callback_url? }
 *
 * Answers 201 with the decision the first time, 200 with the same answer for a retry.
 * status: approved (go ahead) | pending (wait for a human) | refused (never). Act only when may_proceed is true.
 */
export async function onRequestPost({ request }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send the agent key as "Authorization: Bearer <key>".')
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
  if (header && body.idempotency_key !== undefined && body.idempotency_key !== header) {
    return problem(422, 'invalid_request', 'The Idempotency-Key header and idempotency_key in the body differ.')
  }
  const result = await rpc<Answer>('api_request_action', { p_agent_key: key, p_payload: body })
  if (!result.ok) return result.response
  return json(result.data.duplicate ? 200 : 201, result.data)
}
