import { bearer, problem, rpc, json, type Ctx } from '../../../../functions-lib/api'

/**
 * GET /api/v1/actions/{id}   ({id} = request id or code, e.g. REQ-000042)
 * Authorization: Bearer <agent key>
 * The current decision on one of this agent's requests. Act only when may_proceed is true.
 */
export async function onRequestGet({ request, params }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send the agent key as "Authorization: Bearer <key>".')
  const result = await rpc<Record<string, unknown>>('api_action_status', { p_agent_key: key, p_request: String(params.id) })
  return result.ok ? json(200, result.data) : result.response
}
