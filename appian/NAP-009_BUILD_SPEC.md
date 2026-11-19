# Build spec: NAP-009 Payment Release Assistant (Appian simulator)

**For:** the Appian developer who maintains the **Northbridge Agent Platform (simulated)** app in Appbay's Appian
environment. **From:** Agent Control Tower team, 19 Nov 2026. **Effort:** about half a day, including testing.

This file stands on its own: you do not need the Agent Control Tower code. If you build with Claude Code and Appian
DevMCP, give it this whole file and say: *"Read this spec. Show me the plan first, then build it in the Northbridge
Agent Platform (simulated) application, then list what I must do by hand."*

---

## 1. What it is and why

The client demo needs a live moment where **an AI agent asks a human before releasing a £2,000,000 payment**. That agent
must run inside the agent platform (this simulator), not on anyone's laptop.

NAP-009 is a new demo agent in the simulator. Each time someone presses **Release a payment**, it:

1. checks it is allowed to act (on the platform, and in Agent Control Tower);
2. asks Agent Control Tower for permission to release the payment;
3. waits while people approve or reject it (the £2m goes to Ravi Menon, then a second approver);
4. checks once more, and "pays" only if both said yes. Nothing real is paid: it writes an activity row.

**The golden rule:** if anything fails, times out or is unclear, NAP-009 **does not pay**. Never pay without a clear
yes from Agent Control Tower.

## 2. What already exists (do not change it)

The simulator app already has:

- **NAP_AGENT** (one row per agent): `external_id` (NAP-001 …), `name`, `description`, `environment`, `owner_email`,
  `owner_name`, `department`, `status` (`active` or `quarantined`), `status_changed_at`, `status_changed_by`,
  `data_sources` (JSON array), `tools` (JSON array), `data_classifications` (JSON array), `shared_with` (JSON array
  of people), `sessions_30d`, `last_active_at`, `is_deleted`, `created_at`, `created_by`.
- **NAP_AGENT_ACTIVITY**: `external_id`, `occurred_at`, `action` (text 200), `outcome` (`done` or `blocked`),
  `blocked_by` (`platform` or `control-tower`, blank when done).
- **NAP_STATUS_HISTORY**, the **Agents**, **Agent detail**, **Add or edit agent** and **Activity** screens, the admin-only
  **Reset demo data** action, demo agents NAP-001 and NAP-002 (timer process models), and three web APIs:
  `nap-agents`, `nap-agent-status`, `nap-agent-status-set`, run by the service account `act-integration`.

Agent Control Tower reads this app through those three APIs. **Their names, fields and answers must not change.**

## 3. What to build

### 3.1 A ninth seed agent

Add this row to the seed data **and** to **Reset demo data** (so a reset restores nine agents):

| Field | Value |
| --- | --- |
| external_id | `NAP-009` |
| name | `Payment Release Assistant` (exactly, so Agent Control Tower links it to its existing record) |
| description | `Releases approved supplier payments through the SWIFT gateway. Asks Agent Control Tower before every release.` |
| environment | `Production` |
| owner_email / owner_name | `james.whitfield@northbridge.demo` / `James Whitfield` (exactly) |
| department | `Payments` |
| status | `active` |
| data_sources | `["SAP S/4HANA","Supplier master"]` |
| tools | `["SWIFT gateway","Control Tower approval"]` |
| data_classifications | `["confidential"]` |
| shared_with | two people (job title exactly `Payments Analyst`, which may see confidential data; another title would raise a data-access alert in Agent Control Tower): `{"email":"nina.patel@northbridge.demo","name":"Nina Patel","jobTitle":"Payments Analyst","department":"Payments"}` and `{"email":"leo.grant@northbridge.demo","name":"Leo Grant","jobTitle":"Payments Analyst","department":"Payments"}` |
| sessions_30d | `140` |

### 3.2 A new activity outcome

Allow `outcome` = **`waiting`** in NAP_AGENT_ACTIVITY (in addition to `done` and `blocked`), for while a person decides.
On the Activity screen show `waiting` rows in amber (done stays as it is, blocked stays red). Appian refreshes a page
at most every 30 seconds, so on stage press the page's refresh to see a new row at once.

### 3.3 Two constants and the key

| Constant | Value | Notes |
| --- | --- | --- |
| `NAP_ACT_BASE_URL` | `https://agent-control-tower-56p.pages.dev` | The client demo site; the integrations build their URL from it |
| `NAP_009_AGENT_CODE` | `AGT-0001` | The Payment Release Assistant in Agent Control Tower |

**The key** is not a constant (agreed 19 Nov): it is kept **encrypted in NAP-009's own connected system** (3.4), like
NAP-002's. Leave it empty; Rajveer pastes it in after the build (section 6). Never put it anywhere else.


### 3.4 A connected system for Agent Control Tower

- Base URL: `NAP_ACT_BASE_URL`.
- A **new** connected system, separate from NAP-002's (do not change NAP-002's). Every call sends the header
  `Authorization: Bearer <the key, stored encrypted in this connected system>` and `Content-Type: application/json`.
- Timeout: **15 seconds**.
- Treat as **"no answer"**: any timeout, any status other than 200 or 201, or a body that is not valid JSON.

Four integrations on it:

| Name | Method and path | Body |
| --- | --- | --- |
| Check status | `GET /api/v1/agents/{NAP_009_AGENT_CODE}/status` | none |
| Ask to act | `POST /api/v1/actions/request` | see 3.6 |
| Read decision | `GET /api/v1/actions/{request_id}` | none |
| Write log | `POST /api/v1/agents/{NAP_009_AGENT_CODE}/logs` | see step 7 |


### 3.5 The **Release a payment** action

On the **Agent detail** screen, show a **Release a payment** button **only for NAP-009**. It opens a short form:

| Field | Default | Rule |
| --- | --- | --- |
| Supplier | `Hartwell Steel Ltd` | Required |
| Invoice | `HS-48817` | Required |
| Purchase order | `PO-2026-0912` | Required |
| Amount (GBP) | `2000000` | Required, above 0 |
| Reason | `Invoice HS-48817 for the Q4 steel order is due today. It matches purchase order PO-2026-0912 and the goods receipt; paying today avoids a 2% late-payment charge (£40,000).` | Required |

**Release** starts one instance of the process model (3.6) and closes the form. One click on Release with the defaults
is the cue on stage, so the defaults matter.

### 3.6 The process model: NAP-009 Release Payment

One instance per payment (if a loop back inside one instance proves unreliable in this environment, each poll may start
the next instance and end: the request id, request code and the time of the first start are passed along, and the
3-hour limit counts from the first start). No timer start. Inputs: supplier, invoice, purchase order, amount, reason, and `isTest`
(true only when started by API 4 with `test: true`).

In every activity row, write money as `£2,000,000` (pound sign, thousands separators, no pence).

| Step | Do | If it fails or the answer is no |
| --- | --- | --- |
| 1 | Read NAP-009's `status` in NAP_AGENT. It must be `active`. | Activity row: outcome `blocked`, blocked_by `platform`, action `Did not release £2,000,000 to Hartwell Steel Ltd: quarantined on the platform`. **End.** |
| 2 | Call **Check status**. The answer must contain `"may_act": true`. | Activity `blocked`, blocked_by `control-tower`, action `Did not release £2,000,000 to Hartwell Steel Ltd: Control Tower says AGT-0001 is <status>` (or `…: Control Tower did not answer`). **End.** |
| 3 | Call **Ask to act** with the body below. | No answer: activity `blocked`, `control-tower`, `Did not release £2,000,000 to Hartwell Steel Ltd: Control Tower did not answer`. **End. Never pay without an answer.** |
| 4 | Read `status` in the answer. `approved` → go to step 6. `pending` → go to step 5. Anything else (`refused`, `rejected`, `expired`, `cancelled`) → activity `blocked`, `control-tower`, `Did not release £2,000,000 to Hartwell Steel Ltd: <reason from the answer>`. **End.** | |
| 5 | Activity row: outcome `waiting`, blocked_by blank, action `Asked Control Tower to release £2,000,000 to Hartwell Steel Ltd (<request_code>); waiting for a person`. Then every **10 seconds** call **Read decision** with the `request_id`, until `status` is no longer `pending`. Then `approved` → step 6; anything else → activity `blocked`, `control-tower`, with the `reason`. **End.** | A failed read: wait 10 seconds and try again (never pay). After **3 hours** still pending: activity `blocked`, `control-tower`, `No decision in time`. **End.** |
| 6 | Check again, just before paying: NAP_AGENT `status` is still `active`; **Check status** still says `"may_act": true`; and the latest decision has `"may_proceed": true`. | Activity `blocked` (`platform` or `control-tower`), action `Approved, but stopped before paying: <why>`. **End.** |
| 7 | "Pay" (simulated). Activity row: outcome `done`, action `Released £2,000,000 to Hartwell Steel Ltd through the SWIFT gateway (simulated, reference NBK<yymmddhhmmss>)`. Update NAP-009's `last_active_at`. Then call **Write log** with `{"message":"Released £2,000,000 to Hartwell Steel Ltd (simulated SWIFT NBK…)","level":"info","event":"payment.released","request":"<request_code>"}`. | A failed log call is ignored: the payment is already recorded. |

**Body for step 3 (Ask to act):**

```json
{
  "idempotency_key": "nap-009-<process instance id>",
  "action": "payment.release",
  "description": "Release £2,000,000 to supplier Hartwell Steel Ltd",
  "reasoning": "<the reason from the form>",
  "amount": 2000000,
  "currency": "GBP",
  "urgency": "high",
  "target_system": "SWIFT gateway",
  "details": {
    "supplier": "Hartwell Steel Ltd",
    "invoice": "HS-48817",
    "purchase_order": "PO-2026-0912",
    "platform": "NAP-009"
  }
}
```

When `isTest` is true, add `"test": true` inside `details` (Agent Control Tower then emails and alerts nobody).
The `idempotency_key` must stay the same if step 3 is retried within one process instance.

**What Agent Control Tower answers** (examples; ignore fields you do not need):

- Check status: `{"agent_code":"AGT-0001","status":"live","may_act":true,"autonomy_level":3, …}`.
  When the agent is suspended, `"may_act": false` (or an error status): both mean **do not act**.
- Ask to act (HTTP 201, or 200 for a repeat of the same idempotency key):
  `{"request_id":"7d0c…","request_code":"REQ-000123","status":"pending","may_proceed":false,"reason":"AGT-0001 is level 3 and this is outside its limits. A human must approve.", …}`.
  A payment under £250,000 comes back `"status":"approved","may_proceed":true` at once.
- Read decision: the same shape. After Ravi Menon and a second approver approve:
  `{"request_code":"REQ-000123","status":"approved","may_proceed":true,"reason":"Approved by …", …}`.

### 3.7 Web API 4: `nap-payment-release`

So the start can also be tested automatically. Same key and service account as the other three APIs.

- `POST nap-payment-release`, header `Appian-API-Key: <key>`, body:
  `{"supplier":"Hartwell Steel Ltd","invoice":"HS-48817","purchaseOrder":"PO-2026-0912","amount":2000000,"reason":"…","test":true}`
  (all fields required except `test`, which defaults to false).
- Starts one instance of the process model, as the Release button does.
- Answers: **202** `{"externalId":"NAP-009","started":true}`; **400** `{"error":"<what is missing or wrong>"}` (missing
  field, amount not above 0); **409** `{"error":"NAP-009 is quarantined"}` when NAP-009's status is `quarantined`; **404** when NAP-009 is missing
  or deleted.
- Add `nap-payment-release` to what the `act-integration` group may run.

## 4. What must not change

- The three existing APIs, their fields and answers.
- NAP-001 to NAP-008, their timers and their behaviour.
- Status values (`active`, `quarantined`) and the rule that the screens record the signed-in user in
  `status_changed_by` (that is how Agent Control Tower catches changes made outside it).

## 5. Acceptance checks (the developer runs these; the key from section 6 is needed for checks 3 to 6)

1. `nap-agents` returns **nine** agents, NAP-009 with the fields in 3.1.
2. **Reset demo data** restores nine agents, all active except NAP-007, and clears activity and history.
3. NAP-009 → Release a payment, amount `1000` → within a few seconds an activity row `done`: "Released £1,000 to
   Hartwell Steel Ltd …". No one is asked to approve (it is under the agent's limit).
4. Release a payment with the defaults (£2,000,000) → activity `waiting` with a REQ code. Rajveer approves it in
   Agent Control Tower as Ravi Menon, then as Daniel Okafor → within about 10 seconds an activity row `done`.
5. The same, but rejected in Agent Control Tower → activity `blocked` by `control-tower` with the rejection reason;
   no `done` row.
6. Quarantine NAP-009 on its Agent detail screen, then Release a payment → activity `blocked` by `platform`, and no
   request reaches Agent Control Tower. Switch it back on afterwards.
7. Set `NAP_ACT_BASE_URL` to a wrong address (for example `https://example.invalid`), Release a payment → activity
   `blocked` by `control-tower`, "Control Tower did not answer". Put the right address back.
8. `nap-payment-release` with `amount: 0` → 400; with NAP-009 quarantined → 409; with a good body and `test: true`
   → 202 and the process runs (the request in Agent Control Tower is marked as a test).

## 6. Handover: what Rajveer does in Agent Control Tower

After the build (no code needed; about five minutes):

1. Sign in to https://agent-control-tower-56p.pages.dev as **admin@northbridge.demo**.
2. **Integrations** → **Sync now** on *Northbridge Agent Platform (simulated)*. Then **Agents** → **Payment Release
   Assistant**: its platform card shows **NAP-009** (the two are now linked).
3. On the same page: **API keys** → **New key**. Copy the key (it is shown only once) and give it to the Appian
   developer **privately** (not by email or chat), who pastes it into NAP-009's connected system. Or paste it yourself
   in Appian Designer (open the connected system, paste the key, save).
4. Run acceptance checks 3 to 7 together.
5. **After every demo data reset in Agent Control Tower** all keys are deleted: repeat step 3 (the same goes for
   NAP-002's key, in its own connected system, if NAP-002's check is switched on).

## 7. Questions

Ask Rajveer, who will ask the Agent Control Tower team. Please do not change the existing APIs to make NAP-009 easier:
the Control Tower is built against them.
