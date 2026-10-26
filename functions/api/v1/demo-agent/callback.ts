import { problem, rpc, json } from '../../../../functions-lib/api'

/**
 * POST /api/v1/demo-agent/callback
 * Task 2.8: our stand-in for an agent's own server, used by the agent console (demo). It receives the Control Tower's
 * signed decision exactly as a real agent would, and has the database check the ACT-Signature header against the key
 * the agent used. Only requests made from the agent console are accepted.
 */
export async function onRequestPost({ request }: { request: Request }): Promise<Response> {
  const signature = request.headers.get('act-signature') ?? ''
  const body = await request.text()
  if (!signature || body.length > 20_000) return problem(400, 'invalid_request', 'Send the signed decision with an ACT-Signature header.')
  const result = await rpc<string>('demo_agent_receive', { p_body: body, p_signature: signature })
  return result.ok ? json(200, { received: true }) : result.response
}
