import { bearer, problem, rpc, json, type Ctx } from '../../../../functions-lib/api'

/**
 * POST /api/v1/agents/register
 * Authorization: Bearer <integration key>
 * Body: the agent's registry fields (see README). Returns the agent's own API key once.
 */
export async function onRequestPost({ request }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send your integration key as "Authorization: Bearer <key>".')
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return problem(400, 'invalid_json', 'The request body must be JSON.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return problem(400, 'invalid_json', 'The request body must be a JSON object.')
  }
  const result = await rpc<Record<string, unknown>>('api_register_agent', { p_integration_key: key, p_payload: payload })
  return result.ok ? json(201, result.data) : result.response
}
