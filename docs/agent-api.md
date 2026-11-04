# Agent API: ask before acting, then act on the decision

For anyone connecting an AI agent to Agent Control Tower. The agent uses its own key (made on the agent's page in the
Control Tower) as `Authorization: Bearer <agent key>`.

## 1. Ask before acting

`POST /api/v1/actions/request`

```json
{
  "idempotency_key": "pay-HS-48817",
  "action": "payment.release",
  "amount": 2000000, "currency": "GBP",
  "description": "Release £2,000,000 to supplier Hartwell Steel Ltd",
  "reasoning": "Invoice HS-48817 is due today and matches PO-2026-0912",
  "callback_url": "https://your-agent.example.com/act/decisions"
}
```

- `201` the first time, `200` with the same answer when you retry with the same `idempotency_key`.
- `status`: `approved` (go ahead), `pending` (wait for a person) or `refused` (never).
- **Act only when `may_proceed` is `true`.**
- `callback_url` is optional. It must be `https://` and a public host name.

## 2. Get the decision

Either ask, or be told:

- **Ask:** `GET /api/v1/actions/{request_id or REQ-code}` returns the same shape as above.
- **Be told:** when a person decides a request that waited, the Control Tower sends a `POST` to your `callback_url`.

The callback looks like this:

```
POST /act/decisions
Content-Type: application/json
ACT-Event: action.decided
ACT-Delivery: 1234
ACT-Signature: t=1761552000,v1=5f2b…e9

{"event": "action.decided", "delivery_id": 1234, "request_id": "…", "request_code": "REQ-000042",
 "status": "approved", "may_proceed": true, "decision_source": "human",
 "reason": "Approved by Daniel Okafor: Supplier verified", "decided_at": "…", "sent_at": "…", …}
```

- Answer with any `2xx` within 10 seconds.
- Anything else is retried after 1, 2, 5, 15 and 60 minutes (6 tries in all).
- The same `delivery_id` may arrive more than once, so treat repeats as one.

## 3. Check the signature before trusting a callback

`v1` is an HMAC-SHA256. The secret is **the SHA-256 of your agent key, as lowercase hex**. The message is
`<t>.<raw request body>`. Use the body exactly as received, before any JSON parsing.

- Reject the callback if the signature doesn't match.
- Reject it if `t` is more than 5 minutes old.
- Even after a valid callback, act only if `may_proceed` is `true`.

Node.js:

```js
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

function isGenuine(rawBody, header, agentKey) {
  const [, t, v1] = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/) ?? []
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const secret = createHash('sha256').update(agentKey, 'utf8').digest('hex')
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}
```

Python:

```python
import hashlib, hmac, re, time

def is_genuine(raw_body: bytes, header: str, agent_key: str) -> bool:
    m = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", header or "")
    if not m or abs(time.time() - int(m[1])) > 300:
        return False
    secret = hashlib.sha256(agent_key.encode()).hexdigest().encode()
    expected = hmac.new(secret, m[1].encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m[2])
```

The callback is signed with the key that made the request. If you rotate keys, keep the old key until its requests
are decided.

## 4. Check in, so the Control Tower knows you are running

`POST /api/v1/agents/{agent id or code}/heartbeat`, body optional: `{ "note": "Queue: 12 invoices" }` (up to 500 characters).

```json
{ "agent_code": "AGT-0004", "status": "live", "may_act": true, "heard_at": "2026-10-28T09:15:02Z",
  "silent_after_minutes": 60, "check_in_by": "2026-10-28T10:15:02Z" }
```

- An agent's owner or an admin can ask to be told when the agent goes quiet ("flag if silent for more than 1 hour",
  on the agent's page). If nothing is heard from the agent for that long while it is Live, it is flagged as silent.
- **Every call with the key counts**, not only check-ins: asking before acting, reading a decision, the status
  check and writing to the log. Check in when you have nothing else to say, comfortably more often than the limit
  (for a 60-minute limit, every 15 minutes is sensible). `check_in_by` is the latest time; it is `null` when the agent
  is not watched.
- The flag clears as soon as the agent is heard from again.
- `may_act` is `false` when the agent is not Live (for example suspended). Stop acting when you see it.

## 5. Write to the agent log

`POST /api/v1/agents/{agent id or code}/logs`: one entry, or `{ "entries": [ ... ] }` with up to 100.

```json
{ "entries": [
  { "level": "info", "event": "invoice.matched", "message": "Invoice HS-48817 matches PO-2026-0912",
    "details": { "invoice": "HS-48817" }, "id": "run-381-step-1" },
  { "level": "warning", "message": "Above my £250,000 limit; asked for approval", "request": "REQ-000001",
    "occurred_at": "2026-10-28T09:15:00Z" }
] }
```

| Field | Required | Notes |
|---|---|---|
| `message` | yes | Up to 2,000 characters. |
| `level` | no | `debug`, `info` (default), `warning` or `error`. |
| `event` | no | A short code for the kind of step, such as `invoice.matched`. |
| `occurred_at` | no | When it happened (within the last 7 days). Default: when received. |
| `request` | no | One of this agent's requests (`REQ-…` or its id), to link the entry to it. |
| `details` | no | A JSON object, up to 8 KB. Do not put secrets or personal data here. |
| `id` | no | Your own id for the entry. Sending the same id again is ignored, so retries are safe. |

- `201` with `{ "accepted": 2, "duplicates": 0 }`. A batch is stored whole or not at all; a `422` says which entry is
  wrong (`"Entry 2: message is required"`).
- Entries appear on the agent's page for everyone who can see the agent. They can never be edited or deleted, and
  are kept for 90 days.

## 6. Report an incident

`POST /api/v1/incidents` with an `Idempotency-Key` header (recommended: a retry with the same key returns the same
incident instead of opening a second one).

- With the **agent key**, an agent reports something that went wrong in its own work (`agent` may be left out).
- With an **integration key**, a connected system (for example a monitoring or ticketing tool) reports about any
  agent; `agent` is then required.

```json
{ "agent": "AGT-0012", "title": "Invoice INV-77 was paid twice", "severity": "high",
  "description": "The retry after a timeout posted the payment again.", "occurred_at": "2026-11-04T09:15:00Z",
  "details": { "invoice": "INV-77" } }
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Up to 200 characters. |
| `severity` | no | `low`, `medium` (default), `high` or `critical`. Sets the time to resolve it. |
| `agent` | with an integration key | The agent's id or code. With an agent key, it must be that agent if given. |
| `description` | no | Up to 4,000 characters. |
| `occurred_at` | no | When it happened, as an ISO date and time (not in the future). |
| `details` | no | A JSON object, up to 16 KB. Do not put secrets here. |

- `201` with `{ "incident_code": "INC-0007", "status": "open", "severity": "high", "owner": "James Whitfield",
  "sla_minutes": 1440, "due_at": "…", "duplicate": false }`; `200` with the same answer for a retry.
- The incident's owner is the agent's business owner (else its technical owner, else an admin) and is alerted on
  their phone. Time to resolve by severity, until an admin changes it: Critical 4 hours, High 24 hours,
  Medium 3 days, Low 7 days.
- Reporting does not by itself suspend the agent. When someone suspends an agent, an incident opens by itself.

## See it working

In the Control Tower, an admin can open **Agent console**. It plays the Payment Release Assistant and uses exactly this
flow. Its callbacks go to `/api/v1/demo-agent/callback`, which checks the signature as above.
