import { json } from '../../../functions-lib/api'
import { APP_ENV } from '../../../functions-lib/config.js'

export function onRequestGet(): Response {
  return json(200, { ok: true, service: 'agent-control-tower', env: APP_ENV })
}
