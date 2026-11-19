# Appian Agent-Platform Simulator — Build Spec

Copy of the spec doc of 15 Oct 2026, kept here so Claude Code can read it while building. If the two differ, the
doc wins; agree any change with Appbay first, because Agent Control Tower's code is written against this contract.

## Purpose

Build a small stand-in agent platform, **Northbridge Agent Platform (simulated)**, in Appbay's existing Appian
environment by **23 Oct**. Agent Control Tower connects to it from 29 Oct to discover agents, block them and re-block
them when someone switches them back on.

- **What it is:** a table of agents, a few screens, four web APIs and three demo agents that visibly stop when blocked.
- **What it is not:** Microsoft. It must always be named as a simulator in the demo.
- **Owner:** Appian team (build plan task 2.13), 16–23 Oct.
- **Contract:** field names, statuses and API shapes below are fixed.

## Data

Record types backed by Appian's database. Times are stored in UTC.

**NAP_AGENT** — one row per agent

| Column | Type | Rule |
| --- | --- | --- |
| id | integer, auto | Primary key |
| external_id | text 20, unique | Set on create: NAP-001, NAP-002 … never changes |
| name | text 120 | Required |
| description | text 1000 | |
| environment | text 20 | Production or Sandbox |
| owner_email | text 255 | The person responsible; may be blank (an ownerless agent) |
| owner_name | text 120 | |
| department | text 80 | Same names as Control Tower: Payments, Treasury, Retail Lending, Commercial Lending, Operations, Customer Service, Compliance, Technology |
| status | text 20 | Exactly `active` or `quarantined` |
| status_changed_at | datetime | Set on every status change |
| status_changed_by | text 255 | Appian username who changed it, or `act-integration` when Control Tower did |
| data_sources | text 2000 | JSON array of strings, e.g. `["Core banking","CRM"]` |
| tools | text 2000 | JSON array of strings |
| data_classifications | text 200 | JSON array, values only from: public, internal, confidential, restricted, personal |
| shared_with | text 4000 | JSON array of people: `[{"email":"…","name":"…","jobTitle":"…","department":"…"}]` |
| sessions_30d | integer | Demo usage figure |
| last_active_at | datetime | Updated by demo agents |
| is_deleted | boolean | Soft delete; deleted agents disappear from the API |
| created_at / created_by | datetime / text | |

**NAP_AGENT_ACTIVITY** — what the demo agents did

| Column | Type | Rule |
| --- | --- | --- |
| id | integer, auto | Primary key |
| external_id | text 20 | The agent |
| occurred_at | datetime | |
| action | text 200 | e.g. Refund £120 to customer 4471 |
| outcome | text 20 | `done`, `blocked`, or `waiting` (NAP-009 while a person decides) |
| blocked_by | text 40 | `platform` or `control-tower`; blank when done |

**NAP_STATUS_HISTORY** — every status change: id, external_id, old_status, new_status, changed_at, changed_by, reason.

## Web APIs

Three web APIs, each its own alias. Base address: `https://<your-site>/suite/webapi/`. All responses are JSON
(`Content-Type: application/json`), field names in camelCase, times as ISO 8601 UTC (`2026-10-29T09:15:00Z`).
Every call carries the header `Appian-API-Key: <key>`.

| # | Method and alias | Does | Success | Errors |
| --- | --- | --- | --- | --- |
| 1 | GET `nap-agents` | Lists every agent that is not deleted | 200 with `{"agents":[…]}` | 401 bad key |
| 2 | GET `nap-agent-status?externalId=NAP-001` | Reads one agent's status | 200 with a status object | 404 unknown or deleted agent |
| 3 | POST `nap-agent-status-set` | Sets one agent's status | 200 with the new status object | 400 bad status or missing field, 404 unknown agent |
| 4 | POST `nap-payment-release` | Starts NAP-009 on one payment (added 19 Nov, see Demo agents) | 202 with `{"externalId":"NAP-009","started":true}` | 400 missing field or amount not above 0, 409 NAP-009 is quarantined |

**Agent object** (API 1 returns a list of these)

```json
{
  "externalId": "NAP-001",
  "name": "Refund Processor",
  "description": "Issues customer refunds under £500",
  "environment": "Production",
  "status": "active",
  "statusChangedAt": "2026-10-20T08:00:00Z",
  "statusChangedBy": "appian.admin",
  "owner": { "email": "lucy.grant@northbridge.demo", "name": "Lucy Grant" },
  "department": "Customer Service",
  "dataSources": ["Core banking", "CRM"],
  "tools": ["Payments API"],
  "dataClassifications": ["personal", "confidential"],
  "sharedWith": [
    { "email": "ana.costa@northbridge.demo", "name": "Ana Costa", "jobTitle": "Sales Associate", "department": "Retail Lending" }
  ],
  "sessions30d": 412,
  "lastActiveAt": "2026-10-28T17:42:00Z",
  "createdAt": "2026-09-01T10:00:00Z",
  "createdBy": "appian.admin"
}
```

An agent with no owner returns `"owner": null`. Empty lists are `[]`, never null.

**Status object** (APIs 2 and 3 return this)

```json
{ "externalId": "NAP-001", "status": "quarantined", "statusChangedAt": "2026-10-29T09:15:00Z", "statusChangedBy": "act-integration" }
```

**API 3 request body**

```json
{ "externalId": "NAP-001", "status": "quarantined", "reason": "Suspended in Agent Control Tower: incident INC-0007", "requestedBy": "act-integration" }
```

Rules for API 3:

1. `status` must be `active` or `quarantined`; anything else returns 400.
2. Setting the status it already has returns 200 and changes nothing (safe to retry).
3. A real change updates `status`, `status_changed_at`, `status_changed_by` (= `requestedBy`) and writes a
   NAP_STATUS_HISTORY row with the reason.
4. Errors return `{"error":"<plain message>"}` with the status code above.

## Screens

Header text on every screen: **Northbridge Agent Platform (simulated)**. Each action is one click.

| Screen | Shows | Actions |
| --- | --- | --- |
| Agents | Grid: name, owner, department, environment, status (green Active / red Quarantined), status changed by and when | Add agent; open an agent |
| Agent detail | All fields, status history (newest first), last 20 activity rows | **Switch back on** (when quarantined), **Quarantine** (when active), Edit, **Delete** (soft delete, with confirmation) |
| Add or edit agent | Form for every NAP_AGENT field; lists as repeating rows, not raw JSON | Save |
| Activity | Live feed of NAP_AGENT_ACTIVITY, newest first, refreshing every 10 seconds; blocked rows in red | Filter by agent |

Switching an agent back on or quarantining it on these screens records the signed-in Appian user in
`status_changed_by` and in the history. That is the drift Control Tower must catch, so it must not go through API 3.

## Demo agents

Two process models, each started by a timer **every minute**.

| | NAP-001 Refund Processor | NAP-002 Invoice Matcher |
| --- | --- | --- |
| Stopped by | The platform: its own status in NAP_AGENT | Control Tower directly: it asks before each action |
| Before each action it checks | `status` in NAP_AGENT | `GET https://agent-control-tower-56p.pages.dev/api/v1/agents/<agent code>/status` with header `Authorization: Bearer <agent key>`; acts only if the answer has `"may_act": true` |
| If allowed | Writes an activity row: outcome `done`, a made-up action such as "Refund £120 to customer 4471"; updates `last_active_at` | Same, e.g. "Matched invoice INV-20931 to PO-7712" |
| If not allowed | Writes outcome `blocked`, blocked_by `platform` | Writes outcome `blocked`, blocked_by `control-tower` |
| If the check itself fails | n/a | Treat as **not allowed** (fail closed) and write `blocked` |

Appbay provides NAP-002's agent code and key after registering it in Control Tower (29 Oct). Until then NAP-002 runs
with the check switched off by a constant.

### NAP-009 Payment Release Assistant (added 19 Nov 2026, for the £2m payment on stage)

The full, standalone build spec for the Appian developer is [NAP-009_BUILD_SPEC.md](NAP-009_BUILD_SPEC.md); if the two differ, that file wins.

The demo's live approval: an agent on the platform asks Control Tower before releasing a payment, waits while people
decide, and pays only if they approve. Unlike NAP-001 and NAP-002 it has **no timer**: it runs once each time it is
started, from a button or from API 4.

**Started by**

- **Release a payment** on NAP-009's Agent detail screen: a short form with supplier (default `Hartwell Steel Ltd`),
  invoice (`HS-48817`), purchase order (`PO-2026-0912`), amount in GBP (`2000000`) and reason (default `Invoice
  HS-48817 for the Q4 steel order is due today. It matches purchase order PO-2026-0912 and the goods receipt; paying
  today avoids a 2% late-payment charge (£40,000).`). One click on **Release** with the defaults is the stage cue.
- API 4, `POST nap-payment-release`, body `{"supplier":"…","invoice":"…","purchaseOrder":"…","amount":2000000,
  "reason":"…","test":false}` (all but `test` required), for automated checks. `test: true` marks the request as a test
  in Control Tower, so nobody is emailed or alerted.

**Steps** (one process instance per payment; every call to Control Tower uses the integration below)

| # | Step | If it fails or says no |
| --- | --- | --- |
| 1 | NAP-009's own `status` in NAP_AGENT is `active` | Activity `blocked`, blocked_by `platform`, "Did not release £2,000,000 to Hartwell Steel Ltd: quarantined on the platform". End |
| 2 | `GET <base>/api/v1/agents/<agent code>/status`: the answer has `"may_act": true` | Activity `blocked`, blocked_by `control-tower`, with the answer's `status` (or "Control Tower did not answer"). End |
| 3 | `POST <base>/api/v1/actions/request` with the JSON below | Activity `blocked`, blocked_by `control-tower`, "Control Tower did not answer". End (never pay without an answer) |
| 4 | Read `status` in the answer: `approved` → step 6; `pending` → step 5; anything else (`refused`, `rejected`, `expired`, `cancelled`) → activity `blocked`, blocked_by `control-tower`, with the answer's `reason`. End | |
| 5 | Activity `waiting`, "Asked Control Tower to release £2,000,000 to Hartwell Steel Ltd (REQ-000123); waiting for a person". Then every **10 seconds** `GET <base>/api/v1/actions/<request_id>` until `status` is not `pending` (give up after 3 hours: activity `blocked`). `approved` → step 6; anything else → activity `blocked` with the `reason` | A failed read: wait and try again; never pay |
| 6 | Just before paying, check again: NAP_AGENT `status` is `active`, and `GET …/status` has `"may_act": true`, and the decision's `may_proceed` is `true` | Activity `blocked` (`platform` or `control-tower`), "Approved, but stopped before paying: <why>". End |
| 7 | "Pay" (simulated, nothing leaves Appian): activity `done`, "Released £2,000,000 to Hartwell Steel Ltd through the SWIFT gateway (simulated, reference NBK<yymmddhhmmss>)"; update `last_active_at`. Then `POST <base>/api/v1/agents/<agent code>/logs` with `{"message":"Released £2,000,000 to Hartwell Steel Ltd (simulated SWIFT NBK…)","level":"info","event":"payment.released","request":"<request_code>"}` (a failed log call does not undo the payment) | |

**The request body in step 3**

```json
{
  "idempotency_key": "nap-009-<process instance id>",
  "action": "payment.release",
  "description": "Release £2,000,000 to supplier Hartwell Steel Ltd",
  "reasoning": "<the reason from the form>",
  "amount": 2000000, "currency": "GBP", "urgency": "high", "target_system": "SWIFT gateway",
  "details": { "supplier": "Hartwell Steel Ltd", "invoice": "HS-48817", "purchase_order": "PO-2026-0912", "platform": "NAP-009" }
}
```

Add `"test": true` inside `details` when API 4 was called with `test: true`. The amount in the description is
formatted with thousands separators and a £ sign.

**Integration and constants**

- One connected system for Control Tower: base URL from constant `NAP_ACT_BASE_URL` (the client demo site,
  `https://agent-control-tower-56p.pages.dev`), header `Authorization: Bearer <the key, encrypted in the connected system>`, JSON in and out,
  15-second timeout. Treat any non-2xx answer, timeout or unreadable body as "no answer".
- Constants: `NAP_ACT_BASE_URL`; `NAP_009_AGENT_CODE` (`AGT-0001`, the Payment Release Assistant in Control Tower's
  demo data). The agent's key is kept encrypted in NAP-009's own connected system (not a constant, agreed 19 Nov), made in Control Tower on the Payment Release Assistant's page
  (**API keys → New key**). It is a secret: keep it in the constant only. **A demo data reset in Control Tower deletes
  every key**, so make a new one and update the constant after each reset (the same goes for NAP-002's key).
- In Control Tower the sync finds NAP-009 and links it to the Payment Release Assistant (same name and owner), so the
  kill switch on that agent also quarantines NAP-009 on the platform.

## Seed data

| ID | Name | Owner | Department | Data | Shared with | Why it is here |
| --- | --- | --- | --- | --- | --- | --- |
| NAP-001 | Refund Processor | Lucy Grant | Customer Service | personal, confidential | 3 service agents | Demo agent that gets blocked on stage |
| NAP-002 | Invoice Matcher | James Whitfield | Payments | confidential | 2 payments analysts | Demo agent that asks Control Tower before acting |
| NAP-003 | Sales Lead Summariser | Tom Becker | Retail Lending | personal | Ana Costa, **Sales Associate** | PII red flag |
| NAP-004 | Branch Rota Planner | none | Operations | internal | 5 branch managers | Ownerless agent |
| NAP-005 | Credit Memo Helper | Aisha Rahman | Commercial Lending | confidential, restricted | 2 credit analysts | Normal, well-governed agent |
| NAP-006 | Treasury Cash Forecaster | Daniel Okafor | Treasury | confidential | 1 treasury analyst | Normal; Sandbox environment |
| NAP-007 | Complaint Triage Bot | Lucy Grant | Customer Service | personal | 8 service agents | Starts `quarantined` |
| NAP-008 | KYC Document Reader | Omar Farouk | Compliance | personal, restricted | 2 KYC officers | Deleted during the demo to show "Missing at source" |
| NAP-009 | Payment Release Assistant | James Whitfield | Payments | confidential | 2 Payments Analysts | Asks Control Tower before releasing a payment: the £2m on stage (added 19 Nov) |

Owner emails follow `firstname.lastname@northbridge.demo`. Give each agent two or three fitting data sources and tools,
and a `sessions_30d` between 20 and 600. Give NAP-009 the data sources `["SAP S/4HANA","Supplier master"]` and tools `["SWIFT gateway","Control Tower approval"]`.
An admin-only **Reset demo data** action restores exactly this table and
clears activity and history.

## Security and handover

- Service account `act-integration`, in a group that may run only the four web APIs.
- An API key for that service account (Admin Console).
- The key goes straight into GitHub → agent-control-tower → Settings → Secrets and variables → Actions as
  `APPIAN_API_KEY`. Never in chat or email.
- The environment must accept calls from the internet (Control Tower calls from Cloudflare's network).

## Acceptance checks

- API 1 returns all 9 seed agents with every field, and `[]` (not null) for empty lists.
- API 2 for NAP-007 returns `quarantined`; for NAP-999 returns 404 with an error message.
- API 3 sets NAP-001 to `quarantined`: the Agents screen shows red, history shows `act-integration` and the reason,
  and within a minute the Activity feed shows NAP-001 `blocked` by `platform`.
- API 3 with the same status again returns 200 and adds no history row.
- API 3 with status `paused` returns 400.
- **Switch back on** for NAP-001 records the signed-in Appian user, and API 2 shows it straight away.
- Deleting NAP-008 removes it from API 1; API 2 for NAP-008 then returns 404.
- A call without the `Appian-API-Key` header, or with a wrong key, is refused.
- **Reset demo data** restores all nine agents and their starting statuses.
- NAP-009, **Release** with the defaults: the Activity feed shows `waiting` with a REQ code; the request is in Ravi Menon's
  Approvals list in Control Tower; after Ravi and a second approver approve, the feed shows `done` with "Released
  £2,000,000 to Hartwell Steel Ltd" within about 10 seconds. Rejected instead: `blocked` by `control-tower`, nothing released.
- NAP-009 quarantined, then **Release**: `blocked` by `platform`, and no request reaches Control Tower.
- NAP-009 with `NAP_ACT_BASE_URL` set to a wrong address: `blocked` by `control-tower`, "Control Tower did not answer".
