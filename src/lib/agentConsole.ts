// Task 2.8: the agent console (demo). Turns what the demo agent heard into the story shown on screen.

export interface ConsoleEvent {
  id: number
  request_id: string
  kind: 'asked' | 'callback'
  status: string
  may_proceed: boolean
  reason: string | null
  at: string
  request: { request_code: string; description: string | null; amount: number | null; status: string } | null
}

export type ConsoleStep =
  | { kind: 'asked'; at: string; text: string }
  | { kind: 'waiting'; text: string }
  | { kind: 'heard'; at: string; text: string; verified: true }
  | { kind: 'acted'; at: string; text: string; proceeded: boolean }

export interface ConsoleRun { requestId: string; code: string; description: string; steps: ConsoleStep[]; waiting: boolean }

const ACTION = (description: string) => description.replace(/^Release /, 'releasing ')

/** One run per request, newest first: what the agent asked, what it heard back, and what it did. */
export function consoleRuns(events: ConsoleEvent[]): ConsoleRun[] {
  const byRequest = new Map<string, ConsoleEvent[]>()
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    byRequest.set(e.request_id, [...(byRequest.get(e.request_id) ?? []), e])
  }
  const runs: ConsoleRun[] = []
  for (const [requestId, list] of byRequest) {
    const asked = list.find((e) => e.kind === 'asked')
    const heard = list.find((e) => e.kind === 'callback')
    const description = asked?.request?.description ?? heard?.request?.description ?? 'Release a payment'
    const code = asked?.request?.request_code ?? heard?.request?.request_code ?? ''
    const steps: ConsoleStep[] = []
    let waiting = false
    if (asked) {
      if (asked.status === 'pending') {
        steps.push({ kind: 'asked', at: asked.at, text: `Asked the Control Tower before ${ACTION(description)}. Answer: wait for a person. ${asked.reason ?? ''}`.trim() })
        if (!heard) {
          waiting = true
          steps.push({ kind: 'waiting', text: 'Waiting for a person to decide. The Control Tower will call back.' })
        }
      } else {
        // Decided at once by policy: the answer came back with the request itself.
        steps.push({ kind: 'asked', at: asked.at, text: `Asked the Control Tower before ${ACTION(description)}. Answer: ${asked.status}. ${asked.reason ?? ''}`.trim() })
        steps.push(acted(asked.at, asked.may_proceed, description))
      }
    }
    if (heard) {
      steps.push({ kind: 'heard', at: heard.at, verified: true, text: `Decision received from the Control Tower, signature checked: ${heard.reason ?? heard.status}` })
      steps.push(acted(heard.at, heard.may_proceed, description))
    }
    runs.push({ requestId, code, description, steps, waiting })
  }
  return runs.reverse()
}

function acted(at: string, proceed: boolean, description: string): ConsoleStep {
  return proceed
    ? { kind: 'acted', at, proceeded: true, text: `Going ahead: ${ACTION(description)} (simulated).` }
    : { kind: 'acted', at, proceeded: false, text: 'Not going ahead. The payment is not released.' }
}
