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

## See it working

In the Control Tower, an admin can open **Agent console**. It plays the Payment Release Assistant and uses exactly this
flow. Its callbacks go to `/api/v1/demo-agent/callback`, which checks the signature as above.
