// Task 3.2: picks the plug-in for a platform connection stored in the database. Adding a platform means adding a
// plug-in here; nothing that uses plug-ins changes.
import { createAppianPlugin } from './appian'
import { PLATFORM_KINDS, PlatformError, type PlatformKind, type PlatformPlugin } from './types'

export * from './types'

/** A platform connection as the database hands it to the API (with its secret, only through a one-time token). */
export interface PlatformConnection {
  id: string
  kind: string
  base_url: string
  secret: string | null
}

const FACTORIES: Record<PlatformKind, (c: PlatformConnection, fetchImpl: typeof fetch) => PlatformPlugin> = {
  appian_simulator: (c, f) => createAppianPlugin({ baseUrl: c.base_url, apiKey: c.secret ?? '' }, f),
}

export function isPlatformKind(kind: string): kind is PlatformKind {
  return (PLATFORM_KINDS as readonly string[]).includes(kind)
}

export function pluginFor(connection: PlatformConnection, fetchImpl: typeof fetch = fetch): PlatformPlugin {
  if (!isPlatformKind(connection.kind)) throw new PlatformError('refused', `No plug-in for platform kind "${connection.kind}".`)
  return FACTORIES[connection.kind](connection, fetchImpl)
}
