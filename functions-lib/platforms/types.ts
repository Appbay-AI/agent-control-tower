// Task 3.2: what every agent-platform plug-in does. Control Tower talks to platforms (the Appian simulator now,
// Microsoft Copilot Studio later) only through this interface, so the scheduled fetch (3.3), the kill switch (4.2)
// and reconciliation (4.7) are written once and work with any platform. Which plug-in is used comes from the
// platform connection stored in the database, so switching platform needs no code change.
//
// Words used here, the same for every platform:
//   active   the agent may run
//   blocked  the platform stops it (Appian: "quarantined"; Microsoft: "quarantined")

/** The kinds of platform Control Tower can connect to. Microsoft Copilot Studio is added once it has been tested (task 3.1, deferred). */
export const PLATFORM_KINDS = ['appian_simulator'] as const
export type PlatformKind = (typeof PLATFORM_KINDS)[number]

export type PlatformAgentStatus = 'active' | 'blocked'

export interface PlatformPerson {
  email: string
  name: string | null
  jobTitle: string | null
  department: string | null
}

/** One agent as the platform describes it, in Control Tower's words. */
export interface PlatformAgent {
  /** The platform's own id for the agent; never changes. */
  externalId: string
  name: string
  description: string | null
  environment: string | null
  status: PlatformAgentStatus
  statusChangedAt: string | null
  statusChangedBy: string | null
  /** null: the platform says nobody owns it. */
  owner: { email: string; name: string | null } | null
  department: string | null
  dataSources: string[]
  tools: string[]
  dataClassifications: string[]
  sharedWith: PlatformPerson[]
  /** Usage, where the platform provides it. */
  sessions30d: number | null
  lastActiveAt: string | null
  createdAt: string | null
  createdBy: string | null
}

/** An agent's status on the platform, as just read or just set. */
export interface PlatformAgentState {
  externalId: string
  status: PlatformAgentStatus
  changedAt: string | null
  changedBy: string | null
}

/** Why Control Tower is changing an agent's status; the platform records it. */
export interface StatusChange {
  reason: string
  /** Who asked, as the platform should record it (the integration account name). */
  requestedBy: string
}

export interface PlatformPlugin {
  readonly kind: PlatformKind
  /** How the platform is named on screen. */
  readonly label: string
  /** Every agent on the platform (deleted agents are not included). */
  listAgents(): Promise<PlatformAgent[]>
  /** One agent's status. Throws PlatformError 'not_found' if the platform has no such agent. */
  readStatus(externalId: string): Promise<PlatformAgentState>
  /** Stops the agent on the platform. Safe to repeat. Resolves only once the platform says it is blocked. */
  block(externalId: string, change: StatusChange): Promise<PlatformAgentState>
  /** Lets the agent run again. Safe to repeat. Resolves only once the platform says it is active. */
  unblock(externalId: string, change: StatusChange): Promise<PlatformAgentState>
}

/**
 * What went wrong, in terms the callers act on:
 *   unauthorized  the platform refused our credentials; an admin must fix the connection
 *   not_found     no such agent (for reconciliation: "Missing at source")
 *   refused       the platform understood but would not do it
 *   unreachable   no answer, a timeout or a server error; try again later
 *   bad_response  the platform answered with something we do not understand; treated as a failure, never guessed at
 */
export type PlatformErrorCode = 'unauthorized' | 'not_found' | 'refused' | 'unreachable' | 'bad_response'

export class PlatformError extends Error {
  readonly code: PlatformErrorCode
  readonly httpStatus: number | null

  constructor(code: PlatformErrorCode, message: string, httpStatus: number | null = null) {
    super(message)
    this.name = 'PlatformError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
