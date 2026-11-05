import { finishSignIn } from '../../../../functions-lib/microsoft'

/**
 * GET /api/v1/microsoft/callback?code=...&state=...   (task 3.1: Connect Microsoft)
 * Microsoft sends the admin's browser here after sign-in. The one-time code is swapped for a renewable sign-in, which
 * goes straight into the database's locked store; the browser is sent back to the Integrations page with the outcome.
 * The state is single-use and only the database can make one, so this address needs no other secret.
 */
export async function onRequestGet({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url)
  const to = await finishSignIn(url.searchParams).catch(() => '/integrations?microsoft=error&reason=' + encodeURIComponent('Something went wrong. Start again with Connect Microsoft.'))
  return new Response(null, { status: 302, headers: { location: new URL(to, url.origin).toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}
