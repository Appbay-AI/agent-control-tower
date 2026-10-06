import { APP_ENV, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js'

export interface Ctx {
  request: Request
  params: Record<string, string | string[]>
}

export function json(status: number, body: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-act-env': APP_ENV, ...extra },
  })
}

export function problem(status: number, error: string, message: string): Response {
  return json(status, { error, message })
}

/** The key from "Authorization: Bearer <key>". */
export function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? ''
  const m = h.match(/^Bearer\s+(\S+)$/i)
  return m ? m[1] : null
}

/** Postgres error codes raised by the API functions, mapped to HTTP. */
const STATUS_FOR_CODE: Record<string, [number, string]> = {
  '28000': [401, 'unauthorized'],          // invalid_authorization_specification: bad or revoked key
  '42501': [403, 'forbidden'],             // insufficient_privilege
  '23514': [422, 'invalid_request'],       // check_violation: our validation messages
  '22P02': [422, 'invalid_request'],       // invalid_text_representation
  P0002: [404, 'not_found'],               // no_data_found
}

/** Calls a database function through Supabase's REST API with the public key. */
export async function rpc<T>(fn: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch):
  Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let res: Response
  try {
    res = await fetchImpl(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
  } catch {
    return { ok: false, response: problem(503, 'unavailable', 'Control Tower is unreachable. Agents must not act until it answers.') }
  }
  const body = (await res.json().catch(() => null)) as ({ code?: string; message?: string } & T) | null
  if (res.ok) return { ok: true, data: body as T }
  const [status, error] = STATUS_FOR_CODE[body?.code ?? ''] ?? [502, 'upstream_error']
  return { ok: false, response: problem(status, error, body?.message ?? 'Control Tower database error') }
}
