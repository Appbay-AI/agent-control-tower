import { bearer, problem, rpc, json, type Ctx } from '../../../../../functions-lib/api'

interface Status { agent_id: string; agent_code: string; status: string; may_act: boolean; autonomy_level: number }

/**
 * GET /api/v1/agents/{id}/status   ({id} = agent id or code, e.g. AGT-0001)
 * Authorization: Bearer <agent key>
 * Agents call this before acting. If it cannot be reached, they must not act (fail closed).
 */
export async function onRequestGet({ request, params }: Ctx): Promise<Response> {
  const key = bearer(request)
  if (!key) return problem(401, 'unauthorized', 'Send the agent key as "Authorization: Bearer <key>".')
  const result = await rpc<Status>('api_agent_status', { p_agent_key: key })
  if (!result.ok) return result.response
  const id = String(params.id)
  if (id !== result.data.agent_id && id.toUpperCase() !== result.data.agent_code) {
    return problem(403, 'forbidden', 'This key belongs to a different agent.')
  }
  return json(200, result.data)
}
