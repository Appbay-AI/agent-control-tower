# Appian Agent-Platform Simulator — Build Spec

Copy of the spec doc of 15 Oct 2026, kept here so Claude Code can read it while building. If the two differ, the
doc wins; agree any change with Appbay first, because Agent Control Tower's code is written against this contract.

## Purpose

Build a small stand-in agent platform, **Northbridge Agent Platform (simulated)**, in Appbay's existing Appian
environment by **23 Oct**. Agent Control Tower connects to it from 29 Oct to discover agents, block them and re-block
them when someone switches them back on.

- **What it is:** a table of agents, a few screens, three web APIs and two demo agents that visibly stop when blocked.
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
| outcome | text 20 | `done` or `blocked` |
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

Owner emails follow `firstname.lastname@northbridge.demo`. Give each agent two or three fitting data sources and tools,
and a `sessions_30d` between 20 and 600. An admin-only **Reset demo data** action restores exactly this table and
clears activity and history.

## Security and handover

- Service account `act-integration`, in a group that may run only the three web APIs.
- An API key for that service account (Admin Console).
- The key goes straight into GitHub → agent-control-tower → Settings → Secrets and variables → Actions as
  `APPIAN_API_KEY`. Never in chat or email.
- The environment must accept calls from the internet (Control Tower calls from Cloudflare's network).

## Acceptance checks

- API 1 returns all 8 seed agents with every field, and `[]` (not null) for empty lists.
- API 2 for NAP-007 returns `quarantined`; for NAP-999 returns 404 with an error message.
- API 3 sets NAP-001 to `quarantined`: the Agents screen shows red, history shows `act-integration` and the reason,
  and within a minute the Activity feed shows NAP-001 `blocked` by `platform`.
- API 3 with the same status again returns 200 and adds no history row.
- API 3 with status `paused` returns 400.
- **Switch back on** for NAP-001 records the signed-in Appian user, and API 2 shows it straight away.
- Deleting NAP-008 removes it from API 1; API 2 for NAP-008 then returns 404.
- A call without the `Appian-API-Key` header, or with a wrong key, is refused.
- **Reset demo data** restores all eight agents and their starting statuses.
