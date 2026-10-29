// Task 3.2: the plug-in for the Appian agent-platform simulator, "Northbridge Agent Platform (simulated)".
// Written against the contract in appian/SIMULATOR_SPEC.md: three web APIs under <site>/suite/webapi/, each call
// carrying the header Appian-API-Key. Appian says "quarantined" where Control Tower says "blocked".
//
// Anything the simulator answers that does not match the contract is a 'bad_response' error, never a guess: the
// kill switch must not believe an agent is blocked unless the platform clearly says so.
import { callbackUrlProblem } from '../callback'
import {
  PlatformError, type PlatformAgent, type PlatformAgentState, type PlatformAgentStatus, type PlatformPerson,
  type PlatformPlugin, type StatusChange,
} from './types'

export interface AppianConfig {
  /** The Appian site, e.g. https://appbay-demo.appiancloud.com */
  baseUrl: string
  apiKey: string
  /** How long to wait for each call. */
  timeoutMs?: number
}

type Json = Record<string, unknown>

const TO_ACT: Record<string, PlatformAgentStatus> = { active: 'active', quarantined: 'blocked' }
const TO_APPIAN: Record<PlatformAgentStatus, string> = { active: 'active', blocked: 'quarantined' }

function bad(what: string): never {
  throw new PlatformError('bad_response', `The Appian simulator's answer did not match the contract: ${what}`)
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function text(o: Json, field: string, where: string, required = false): string | null {
  const v = o[field]
  if (v === null || v === undefined || v === '') {
    if (required) bad(`${where} has no ${field}`)
    return null
  }
  if (typeof v !== 'string') bad(`${where}.${field} is not text`)
  return v
}

function time(o: Json, field: string, where: string): string | null {
  const v = text(o, field, where)
  if (v !== null && Number.isNaN(Date.parse(v))) bad(`${where}.${field} is not a date and time`)
  return v
}

function strings(o: Json, field: string, where: string): string[] {
  const v = o[field]
  if (v === null || v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`${where}.${field} is not a list of text`)
  return v as string[]
}

function status(o: Json, where: string): PlatformAgentStatus {
  const s = o.status
  const mapped = typeof s === 'string' ? TO_ACT[s] : undefined
  if (!mapped) bad(`${where}.status is ${JSON.stringify(s)}, not "active" or "quarantined"`)
  return mapped
}

function person(v: unknown, where: string): PlatformPerson {
  if (!isObj(v)) bad(`${where} is not a person`)
  return { email: text(v, 'email', where, true)!, name: text(v, 'name', where), jobTitle: text(v, 'jobTitle', where), department: text(v, 'department', where) }
}

export function parseAgent(v: unknown, i: number): PlatformAgent {
  if (!isObj(v)) bad(`agent ${i + 1} is not an object`)
  const where = typeof v.externalId === 'string' && v.externalId ? v.externalId : `agent ${i + 1}`
  const owner = v.owner === null || v.owner === undefined ? null : person(v.owner, `${where}.owner`)
  const shared = v.sharedWith ?? []
  if (!Array.isArray(shared)) bad(`${where}.sharedWith is not a list`)
  const sessions = v.sessions30d
  if (sessions !== null && sessions !== undefined && (typeof sessions !== 'number' || !Number.isFinite(sessions) || sessions < 0)) {
    bad(`${where}.sessions30d is not a number`)
  }
  return {
    externalId: text(v, 'externalId', where, true)!,
    name: text(v, 'name', where, true)!,
    description: text(v, 'description', where),
    environment: text(v, 'environment', where),
    status: status(v, where),
    statusChangedAt: time(v, 'statusChangedAt', where),
    statusChangedBy: text(v, 'statusChangedBy', where),
    owner: owner && { email: owner.email, name: owner.name },
    department: text(v, 'department', where),
    dataSources: strings(v, 'dataSources', where),
    tools: strings(v, 'tools', where),
    dataClassifications: strings(v, 'dataClassifications', where),
    sharedWith: shared.map((p, n) => person(p, `${where}.sharedWith[${n}]`)),
    sessions30d: typeof sessions === 'number' ? sessions : null,
    lastActiveAt: time(v, 'lastActiveAt', where),
    createdAt: time(v, 'createdAt', where),
    createdBy: text(v, 'createdBy', where),
  }
}

function parseState(v: unknown, expectId: string): PlatformAgentState {
  if (!isObj(v)) bad('the status answer is not an object')
  const id = text(v, 'externalId', 'the status answer', true)!
  if (id !== expectId) bad(`asked about ${expectId} but the answer is about ${id}`)
  return { externalId: id, status: status(v, id), changedAt: time(v, 'statusChangedAt', id), changedBy: text(v, 'statusChangedBy', id) }
}

export function createAppianPlugin(config: AppianConfig, fetchImpl: typeof fetch = fetch): PlatformPlugin {
  const problem = callbackUrlProblem(config.baseUrl)
  if (problem) throw new PlatformError('refused', `The Appian site address ${problem}.`)
  if (!config.apiKey) throw new PlatformError('unauthorized', 'No Appian API key is stored for this connection.')
  const root = `${config.baseUrl.replace(/\/+$/, '')}/suite/webapi/`
  const timeoutMs = config.timeoutMs ?? 15_000

  async function call(path: string, body?: Json): Promise<unknown> {
    let res: Response
    try {
      res = await fetchImpl(root + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          accept: 'application/json',
          'Appian-API-Key': config.apiKey,
          'user-agent': 'AgentControlTower-Platform/1',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual', // Appian redirects to its sign-in page when the key is not accepted
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const name = (e as Error).name
      throw new PlatformError('unreachable', name === 'TimeoutError' || name === 'AbortError'
        ? `The Appian simulator did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
        : `Could not connect to the Appian simulator: ${(e as Error).message}`)
    }
    const raw = await res.text().catch(() => '')
    let parsed: unknown = null
    try { parsed = raw ? JSON.parse(raw) : null } catch { /* not JSON */ }
    const said = isObj(parsed) && typeof parsed.error === 'string' ? `: ${parsed.error}` : ''
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new PlatformError('unauthorized', `The Appian simulator refused the API key (HTTP ${res.status}).`, res.status)
    }
    if (res.status === 404) throw new PlatformError('not_found', `The Appian simulator has no such agent${said}.`, 404)
    if (res.status === 400) throw new PlatformError('refused', `The Appian simulator refused the request${said}.`, 400)
    if (res.status !== 200) throw new PlatformError('unreachable', `The Appian simulator answered HTTP ${res.status}${said}.`, res.status)
    if (parsed === null) bad('the answer is not JSON')
    return parsed
  }

  async function setStatus(externalId: string, want: PlatformAgentStatus, change: StatusChange): Promise<PlatformAgentState> {
    if (!change.reason.trim() || !change.requestedBy.trim()) throw new PlatformError('refused', 'A reason and who asked are required.')
    const answer = parseState(await call('nap-agent-status-set', {
      externalId, status: TO_APPIAN[want], reason: change.reason, requestedBy: change.requestedBy,
    }), externalId)
    if (answer.status !== want) bad(`asked for ${externalId} to be ${want} but the simulator says it is ${answer.status}`)
    return answer
  }

  return {
    kind: 'appian_simulator',
    label: 'Northbridge Agent Platform (simulated)',
    async listAgents() {
      const answer = await call('nap-agents')
      if (!isObj(answer) || !Array.isArray(answer.agents)) bad('expected {"agents": [...]}')
      const agents = answer.agents.map(parseAgent)
      const seen = new Set<string>()
      for (const a of agents) {
        if (seen.has(a.externalId)) bad(`${a.externalId} is listed twice`)
        seen.add(a.externalId)
      }
      return agents
    },
    async readStatus(externalId) {
      return parseState(await call(`nap-agent-status?externalId=${encodeURIComponent(externalId)}`), externalId)
    },
    block: (externalId, change) => setStatus(externalId, 'blocked', change),
    unblock: (externalId, change) => setStatus(externalId, 'active', change),
  }
}
