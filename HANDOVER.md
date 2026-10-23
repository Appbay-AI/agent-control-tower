# Agent Control Tower: handover for the next Claude

Read this first. It is written so a new Claude session can continue the work without the earlier conversation. Where this file and the code disagree, the code on `main` wins; update this file when you change something it describes.

Secrets are never written in this file or in the repo. Keys and passwords live only in GitHub Secrets, the Appian platform, or the user's own notes.

---

## 1. What we are building

**Agent Control Tower**: a governance app for AI agents at **Appbay Technologies**, a ~25-person Appian and Databricks partner in India (company domain appbay.ai, GitHub org `Appbay-AI`).

The app does four things:
- keeps a **register** of every AI agent a company runs;
- makes a **human approve** high-risk agent actions before they happen;
- gives an **audited kill switch** that stops an agent (where the platform allows it);
- keeps **incidents** and a one-click **evidence pack**.

Phase 2 added: auto-discovery of agents on connected platforms (Microsoft Copilot Studio, Appian), a platform kill switch, reconciliation, alert routing and reporting. The user chose **one single release** containing everything, not staged releases.

### Hard constraints from the user
- **Free end to end for the demo.** Paid services were rejected: "We don't have to take priced solutions as it defeats one of the early requirement of the tech stacks being free." Check any new service for a free tier from official docs before adopting it.
- **Built and maintained by AI.** The user is not a programmer. They know Appian. They build by giving step-by-step prompts to Claude Code. Explain things in plain words, keep steps small, and say what the user has to do themselves.
- **Responsive web app, installable on phones (PWA)**. Native apps are not needed.
- **Do not hallucinate feasibility.** For any technical or cost claim, verify against official documentation and cite it. The user explicitly asked for this.
- Appbay is **not** a Microsoft partner and has no Visual Studio subscription. Do not plan on a paid Microsoft tenant for the demo.

### The Microsoft workaround (important)
Microsoft Copilot Studio can't be used for the demo without paid capacity. The workaround: an **Appian-hosted simulator** named **"Northbridge Agent Platform (simulated)"**, running in Appbay's existing Appian environment. It exposes the same kind of endpoints a real agent platform would. It must always be named as a simulator, never presented as Microsoft.

---

## 2. Who the user is and how to work with them

- Non-programmer, Appian expert, uses Claude Code in VS Code with the Appian DevMCP plug-in.
- Wants short, plain-language replies. Tables and checklists are fine; avoid jargon or define it.
- Expects you to **do the work**, then report what changed and what they must do. Do not ask for permission on routine steps.
- Asked for the **build plan as a PDF**, kept up to date (see section 9).
- Pastes bug reports directly ("Cannot coerce…", "I don't see any users page"). Diagnose from the code and database, fix, and say what caused it.
- They have said: release to the client demo only with their go-ahead. Do not release to `demo` on your own.
- They accept a short answer followed by a clear next step.

---

## 3. Stack

| Part | Choice | Notes |
|---|---|---|
| Language | TypeScript | |
| UI | React 19 + Vite | `vite-plugin-pwa` for install + auto-update (`registerSW` in `main.tsx`, `injectRegister: false`) |
| Styling | Tailwind v4 + shadcn/ui | shadcn components copied into the repo by hand (the CLI could not reach the registry) |
| Icons / routing | lucide-react, react-router | |
| Database / auth | Supabase (Postgres 17, Auth, RLS) | Two hosted projects, see below |
| Scheduled work | `pg_cron` / keep-alive GitHub workflow | Supabase Edge Functions and scheduled functions were tried and did not work (access-token failure), so the team moved away from them |
| API hosting | Cloudflare Pages Functions | `functions/api/v1/*`, shared helpers in `functions-lib/api.ts` |
| Hosting | Cloudflare Pages | |
| Email | Resend (planned) | Domain `notify.appbay.ai`, DNS not done yet |
| Phone alerts | Web Push (browsers' own push services: Google, Apple, Mozilla) | Free, no account. Database queues, `pg_net` calls our Cloudflare function, which encrypts and sends (task 2.6) |
| CI/CD | GitHub Actions | Deploy is by `wrangler pages deploy` from Actions, not Cloudflare's Git connection |
| Tests | Vitest (unit), PGlite (in-memory Postgres for DB tests), Playwright (browser tests, desktop and Pixel 7) | |
| Lint / types | oxlint, `tsc -b` | |

### Environments

| Name | Supabase project | Site | Updated by |
|---|---|---|---|
| dev | `act-dev` (ref `gprwtthwvmmmbslccxpf`) | https://main.agent-control-tower-56p.pages.dev (work in progress) | Automatic on every merge to `main` |
| demo | `act-demo` (ref `ekowumwkevkzwvkiljvf`) | https://agent-control-tower-56p.pages.dev (client demo) | By hand: Actions → *Database migrations* → `demo` |

The Pages production branch is `demo`. To update the client demo: merge `main` into `demo`, then run the migrations workflow for `demo` if the release has database changes, then seed if needed.

### Appian simulator
- Site: `https://appbay-demo.appiancloud.com` (Appbay's existing Appian environment).
- Spec: `appian/SIMULATOR_SPEC.md` (a copy of the one the user placed at `D:\Appbay\DAAM\appian\SIMULATOR_SPEC.md` on their machine).
- DevMCP setup and seven prompts for Claude Code: `appian/DEVMCP_BUILD_GUIDE.md`; `appian/mcp.json.example` (real `.mcp.json` is git-ignored).
- Built by the user with Appian DevMCP. The user confirmed it is done and the API returns the agent list.
- Read-only checks: `scripts/appian-check.mjs` + workflow `appian-check.yml`. Last run: **15 of 15 PASS**. It briefly quarantines NAP-001 and restores it. Secret used: `APPIAN_API_KEY` (plus `APPIAN_BASE`).
- Seed agents: NAP-001 to NAP-008. NAP-004 has no owner. NAP-003 is shared with a Sales Associate. NAP-007 starts quarantined. NAP-002's agent key/code is to be given to Appbay after registration in the Control Tower (planned for 29 Oct).

Appian Web API contract the Control Tower calls:
- `GET nap-agents`: list of agents (ids, name, owner, department, data sources, tools, data classifications, sharing, status, timestamps).
- `GET nap-agent-status?externalId=NAP-xxx`: one agent's status (404 with an error for unknown agents).
- `POST nap-agent-status-set`: body `{externalId, status: "active" | "quarantined", reason, requestedBy}`. Other statuses are refused with 400. Retrying the same status returns 200.
- Every call sends the header `Appian-API-Key`. Missing or wrong key → 401/403.

### Microsoft (research, not yet tested live)
Findings from official docs (verified in an earlier session; re-verify before relying on them):
- Quarantine for Copilot Studio agents uses the Power Platform `copilotstudio` API (`api.powerplatform.com`, `SetAsQuarantined` / `SetAsUnquarantined`). **Admin roles only.** Classic chatbots are refused.
- The Power Platform inventory API is delegated (user sign-in) only, and refreshes about every 15–20 minutes.
- Microsoft Graph needs `$select` for the department field.
- The audit log has no quarantine events.
- A trial tenant cannot publish agents.
- Costs quoted: Copilot Studio capacity pack ₹16,640/month (US$200, 25,000 credits); Microsoft 365 Business Basic ₹170/user/month on an annual plan. The ₹35,300 figure from earlier is a Copilot Studio quote, not the chosen route.
- Spike script `scripts/ms-spike.mjs` + workflow `ms-spike.yml` (device-code sign-in, checks A1–D3). **Not yet run**: needs a tenant ID and client ID from the user, plus sign-in at microsoft.com/devicelogin. Optional inputs: `test_agent`, `audit_query_id`.

---

## 4. Repository layout

```
src/                       React app
  pages/                   AgentsPage, AgentDetailPage, AgentFormPage, ApprovalsPage, RequestPage,
                           UsersPage, UserFormPage, ChangePasswordPage, LoginPage,
                           RoutingPage, IntegrationsPage
  components/              shared UI: DecisionPanel (registrations), RequestDecisionPanel (action requests),
                           badges, requestBadges, ui-bits, TempPasswordDialog, ui/ (shadcn)
  lib/                     types.ts, api.ts (all DB/API calls), auth.tsx (session, loadSeq guard),
                           permissions.ts, requests.ts, users.ts, routing.ts, format.ts, approvals.ts (list loader), live.tsx (task 2.5), push.ts (task 2.6) (+ unit tests)
  App.tsx                  routes; admin-only routes wrapped in RequireAdmin
  components/Layout.tsx    navigation (Routing is admin-only)
functions/api/v1/          Cloudflare Pages Functions (public API): health.ts, agents/register.ts,
                           agents/[id]/..., actions/...
  actions/request.ts       POST action request (Idempotency-Key header or body)
  actions/[id].ts          GET action request by REQ code or id
functions-lib/api.ts       rpc() helper: SQLSTATE → HTTP status
functions/api.test.ts      API unit tests
supabase/migrations/       every schema change, in order (the record of the database)
supabase/seed/             demo data: 00_helpers, 01_users, 02_demo_bank, 03_more_agents,
                           04_routing, 05_action_requests, 90_reset
db-tests/                  PGlite tests: harness.ts + users, actions, routing, tasks, realtime, push, seed, audit, security, workflow
e2e/                       Playwright tests: registry, users, routing, requests, live, alerts (Chrome, real push)
docs/build-plan/           build plan source (build.py → plan.html, print.mjs → PDF) and the latest PDF
scripts/                   register-agent.mjs, ms-spike.mjs, appian-check.mjs
appian/                    simulator spec, DevMCP guide, mcp.json.example
.github/workflows/         see section 6
```

Local commands (from the repo root, after `npm install`):
- `npm test`: unit tests (first `cp functions-lib/config.example.js functions-lib/config.js`, as CI does; it is git-ignored)
- `npm run test:db`: database tests on PGlite
- `npm run typecheck`, `npm run lint`, `npm run build`
- `npm run dev`: optional; needs `.env.local` (see `.env.example`)

Git: branches `main` (work in progress, auto-deploys to dev) and `demo` (client demo). Claude Code sessions work on a `claude/...` branch the session names, and merge to `main` only when the user asks.
- Task 2.6 (phone alerts) is on branch `claude/task-2.6-push-alerts`, **not yet merged to `main`**. Its migration `20261024000100_push_alerts.sql` was applied to the **dev** database from that branch with `alerts_site` set to the preview, so dev's alerts are currently sent by the preview https://claude-task-2-6-push-alerts.agent-control-tower-56p.pages.dev. After the merge, the automatic *Database migrations* run on `main` points dev back at the main site (or run it by hand for dev). e2e passed twice on the preview, including real push in Chrome.
- Task 2.5 (live approvals list) was built on branch `claude/task-2.5-live-approvals` (`05ef120`, `50317b8`, `d5fb23b`, `074ca6c`) and fast-forwarded onto `main` on 23 Oct with the user's go-ahead; checks, dev deploy, e2e and api-smoke passed. **Not yet on demo.** Its migration `20261023000100_realtime_approvals.sql` was applied to the **dev** database from that branch (verified: the three tables are in the `supabase_realtime` publication on dev). Preview: https://claude-task-2-5-live-approva.agent-control-tower-56p.pages.dev; e2e passed twice there (desktop and phone). Merging is a fast-forward; the migration will not run twice on dev.
- `main`: task 2.4 (`086ee38`, `588e09a`) was fast-forwarded onto `main` on 22 Oct with the user's go-ahead; checks, dev deploy, e2e (desktop and phone) and api-smoke all passed. The commit after that updates this file and the build plan. Below 2.4: `c259d55`/`ba05d55` routing (2.3), `fd7b87e`/`a7a2d1c`/`3e6b048` Appian, `bef46bc` seed review dates, `dfec9dd` action requests (2.1, 2.2).
- `demo`: **released 22 Oct** at `588e09a` (2.1 to 2.4, the seed date fix, Appian workflows), on the user's go-ahead. Order used: *Database migrations* → demo (from `main`), then fast-forward `demo` to `main` (deploy succeeded, `/api/v1/health` says `env: demo`), then *Seed demo data* → demo with reset. Checked afterwards on demo: 40 agents, 4 overdue reviews, no test agents, both routing rules, and `REQ-000001` (£2,000,000 GBP, pending, with Ravi Menon). The reset removed three hand-made test agents ("Test Agent", "Test Agent 2", "test agent 3") from 7–9 Oct. Later commits on `main` that only touch docs do not need releasing.
- Old branches: `claude/quirky-planck-d1h2jp` is fully merged and `handover-for-new-session` (05166ab) holds an outdated copy of this file. Both can be deleted when the user agrees.

Preview a branch: run *Deploy* on the branch (workflow_dispatch). It deploys to `https://<branch-with-dashes>.agent-control-tower-56p.pages.dev` using the dev database. Cloudflare cuts that first part to **28 characters** (e.g. `claude/task-2.5-live-approvals` → `claude-task-2-5-live-approva`). If the branch has a migration, first run *Database migrations* → dev on the branch. Then run *End-to-end* on the branch with input `url` set to that address.

---

## 5. Rules of the codebase (follow these)

1. **Every schema change is a new migration file** in `supabase/migrations/`, named by timestamp, e.g. `20261016000100_routing_matrix.sql`. Never change the database by hand in the dashboard, and never edit an old migration that has already run on demo.
2. **Grants are explicit.** New Supabase projects grant nothing by default. Every new table needs RLS policies **and** `grant ... to authenticated` (and `anon` only where the public API needs it).
3. **Functions are locked down.** Supabase grants execute to everyone by default. Every migration that adds a function ends with `revoke execute on function ... from public, anon, authenticated;` and then grants only what is needed.
4. **Audit.** Governed tables have an `audit_table_change` trigger. `audit_events` is insert-only and hash-chained. Actions that need a reason set `act.reason`; the code reads `act.actor_type` / `act.actor_id`.
5. **Security definer functions** use `set search_path = ''` and fully qualified names.
6. **Never show raw database errors.** Errors from the database are mapped to plain messages. `maybeSingle` is used instead of `single`. "Cannot coerce the result to a single JSON object" must never appear; it was caused by a stale page after sign-out and is fixed.
7. **PWA updates**: new builds install automatically; a stale cached build can show old screens (the user once saw no Users page this way). A hard refresh fixes it.
8. **Seed data dates are relative to today.** Review dates for not-yet-due reviews are pushed at least 45–47 days out so the "4 overdue" demo story holds after a reset.
9. **Tests must pass before you say something works**: `npm test`, `npm run test:db`, `npm run typecheck`, `npm run lint`, and the e2e workflow for UI changes.
10. **Secrets**: only in GitHub Secrets or Supabase/Cloudflare/Appian dashboards. Never in code, docs or chat. Note: the secret-listing API returns 403 from the Claude sandbox, so secret names can't be verified from there; the workflows prove whether they work.

---

## 6. GitHub Actions workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push / PR | typecheck, lint, unit tests, db tests, build |
| `deploy.yml` | push to `main` (dev preview) and `demo` (production) | builds and deploys to Cloudflare Pages via `wrangler pages deploy` |
| `db-migrate.yml` | push to `main` (dev, automatic); manual for `demo` | applies `supabase/migrations` to the chosen project, then *Phone alert keys* (`scripts/push-setup.mjs`): sets the alert site for that environment and creates the VAPID keys once. Optional input `alerts_site` (dev only) points alerts at a branch preview for testing |
| `seed-demo.yml` | manual; inputs `target` (dev/demo) and `reset` (true/false) | loads demo data. Reset clears test agents, requests and routing rules first |
| `e2e.yml` | after deploy and manual (optional input `url` for a branch preview) | Playwright on the work-in-progress site. Makes a temporary agent key for the Payment Release Assistant (`ACT_AGENT_KEY`) for the approver-task test. Cleans up leftovers: retires test agents, revokes that key, cancels waiting `E2E` requests, deletes `e2e.user.%` auth users and `E2E rule %` routing rules. On success it posts test timings (lines `[desktop\|phone] task appeared N ms` and `[push] alert arrived: …`) as a "Timings" notice, readable through check-run annotations. Runs under `xvfb-run` (the alert test needs a windowed Chrome) and also removes Ravi's `Linux · Chrome%` test devices |
| `api-smoke.yml` | after deploy and manual | calls the public API end to end |
| `keep-alive.yml` | scheduled | keeps the Supabase projects awake |
| `db-inspect.yml` | manual | read-only database look-up |
| `ms-spike.yml` | manual | Microsoft spike, device-code sign-in (inputs: tenant_id, client_id, test_agent, audit_query_id) |
| `appian-check.yml` | manual / after changes | Appian simulator acceptance checks |

Repository secrets known to be needed: `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APPIAN_API_KEY`. Per-environment (dev, demo) variables and secrets: `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_DB_PASSWORD`. Database access uses the Supabase pooler URL (`SUPABASE_DB_URL`), not Edge Functions.

---

## 7. Data model and behaviour (as built)

### Roles and access
- Roles in `user_roles`: `admin`, `owner`, `approver`, `executive`, `auditor`.
- `sees_everything()` is true for admin, executive and auditor.
- `can_see_agent(agent)` is true for sees-everything users, the agent's owners and creator, approvers whose department scope covers the agent's department, and **assigned approvers of a pending request for that agent** (added in task 2.3).
- `is_active_user()` must be true for anything to be visible. Deactivated people are "no owner" in screens: a deactivated owner shows as missing and raises an `owner_missing` alert.
- Users admin (admin only): list, create (one-time temporary password, `must_change_password` forces a change at first sign-in), update, reset password, activate/deactivate (requires a reason). Guards: an admin cannot remove their own admin role, and at least one active admin must remain.
- Approver scope = the departments an approver may decide for (`approver_scopes`).

### Agents
- Registry with statuses such as Live, Approved, Quarantined, Retired. Lifecycle changes go through functions; `act.allow_lifecycle` is set only by controlled code paths.
- Agents have: owners (business and technical), creator, department, risk tier, autonomy level (1 to 4), data classifications (`data_classifications`, a list), spend limits.
- Each agent gets an API key (`create_agent_api_key`). Its key is used by the public API.

### Action requests (task 2.1 and 2.2)
- Table `action_requests`: request code `REQ-000001` style (`action_request_code_seq`), `idempotency_key`, `request_hash` (sha256 of the payload). Uniqueness on `(agent_id, idempotency_key)`.
- Fields: action, amount and currency, volume, urgency, details (jsonb), callback URL (https only), snapshot of autonomy and thresholds, status, decision source and reason, decided by and at.
- Decided requests are immutable (guard trigger).
- **Decision logic `decide_action()`** (pure):
  - Level 1: refused.
  - Level 2: pending for a human.
  - Level 3: approved if within the value limit and the 24-hour volume limit; otherwise pending.
  - Level 4: approved.
  - Any agent that is not Live is always refused.
  - `may_proceed` = approved **and** the agent is still live at the moment it asks.
- Public API (Pages Functions, authenticated by the agent's API key):
  - `POST /api/v1/actions/request`: returns **201** for a new request and **200** for a duplicate (same idempotency key). Returns 422 if the header and body keys differ.
  - `GET /api/v1/actions/[id]`: read a request by REQ code or id.
- Error mapping (`functions-lib/api.ts`): 28000→401, 42501→403, 23514/22P02→422, 23505→409, P0002→404, anything else→502, network failure→503.

### Routing matrix (task 2.3, done)
- Table `routing_rules`: name, priority (lower is checked first, 1 to 9999), is_active, and optional conditions: agent, department, amount band (`min_amount`/`max_amount` with `currency`; the band includes its lower edge only), data classification, minimum risk tier. Then `approver_id` (must be an active user with the Approver role; enforced by trigger).
- Rules are checked in priority order. The first rule that matches **and** whose approver can act wins. A rule is skipped (and the reason recorded) if its approver is inactive, lacks the Approver role, or owns or created the agent.
- No rule matches → any approver whose scope covers the agent's department (the "No rule matched" note).
- Trigger `action_requests_route` assigns the approver when a pending request is recorded. It stores `assigned_to`, `routing_rule_id`, `routing_note`, `routed_at`.
- `reroute_pending_requests()` (admin only): re-applies rules to requests still waiting. Logged with reason "Routing rules re-applied by admin".
- `preview_routing(agent, amount, currency)`: admin, approver, executive or auditor. Returns the rule, approver and department approvers.
- Screen `/routing` (admin only): ordered rule list with reorder, edit, delete, "Apply to waiting requests", and "Test a request". Every change is audited (`routing_rules.insert` / update / delete).
- Demo rules (`supabase/seed/04_routing.sql`, idempotent):
  - "Large payments (£1m and above)": Payments, GBP ≥ 1,000,000 → **Ravi Menon**, priority 10.
  - "Agents that touch personal data": personal → **Omar Farouk**, priority 20.
  - Reset (`90_reset.sql`) truncates `routing_rules` and restores these two via the seed.
- Tests: `db-tests/routing.test.ts` (10 tests), `src/lib/routing.test.ts` (3), `e2e/routing.spec.ts` (adds a rule, checks Daniel gets the £2m payment, deletes it, checks Ravi again). Browser test passes on dev.

### Approver task screen (task 2.4, done, on main and demo)
- Migration `20261019000100_approver_tasks.sql`. New columns on `action_requests`: `hold_reason` (why it waited, the policy's words, set by the routing trigger), `escalated_by`, `escalated_at`, `escalation_reason`.
- Who decides (`can_decide_request`): an active user with the Approver role who does not own or create the agent, and who is the assigned approver; if nobody is assigned, any approver whose scope covers the agent's department. **Admins do not decide agent actions** (they manage routing and can re-apply rules).
- `decide_action_request(id, 'approve' | 'reject', reason)`: reject needs a reason; approve fails if the agent is no longer Live ("cannot be approved. Reject it instead."). Sets `decision_source = 'human'`, `decided_by`, `decided_at`, and `decision_reason` = "Approved by Ravi Menon: <note>" / "Rejected by …: <reason>". The agent sees this text through `GET /api/v1/actions/{id}`.
- `escalate_action_request(id, to, reason)`: reason required; target must be an active approver, not the caller, not the agent's owner or creator. Moves `assigned_to`, clears `routing_rule_id`, writes "Escalated by X to Y: reason" into `routing_note`. `escalation_targets(id)` lists who it can go to.
- `reroute_pending_requests()` now skips escalated requests.
- Every decision and escalation is an `action_requests.update` audit event with the reason.
- Screens: `/approvals` lists "Agent actions" waiting for you (oldest first) above "New agents"; `/approvals/requests/:id` (RequestPage) shows the headline ("Payment Release Assistant wants to release £2,000,000 to …"), amount, the agent's reason ("Because"), why it needs a person, routing, request details and the agent's profile, with Approve (optional note) / Reject (reason) / Escalate (person + reason). After escalating, the page returns to the list with a notice.
- Demo data `05_action_requests.sql`: the Payment Release Assistant asks to release £2,000,000 to Hartwell Steel Ltd (above its £250k limit) → waits with Ravi Menon. Made through `api_request_action` with a temporary key that is revoked straight after. Idempotent.
- Tests: `db-tests/tasks.test.ts` (10), seed test (+1), `src/lib/requests.test.ts` (7), `src/components/RequestDecisionPanel.test.tsx` (4), `e2e/requests.spec.ts` (desktop and phone: agent asks via the API, Ravi escalates to Daniel, Daniel approves, API says may_proceed).

### Live approvals list (task 2.5, done, on main; not on demo)
- Supabase Realtime **Postgres Changes** (free plan: 200 concurrent connections, 100 messages/s, 2 million messages/month; checked 23 Oct at supabase.com/docs/guides/realtime/limits and supabase.com/pricing).
- Migration `20261023000100_realtime_approvals.sql` adds `action_requests`, `agent_registrations`, `registration_decisions` to the `supabase_realtime` publication (idempotent; creates the publication if missing). Realtime applies each subscriber's RLS, so the existing select policies decide who hears about what. DELETE events are not RLS-filtered, but these tables are never deleted from (reset uses truncate, which sends nothing).
- App: `src/lib/live.tsx` `LiveProvider` (inside `Layout`) opens one channel per signed-in person. **Any change only triggers a re-read** of the list (`src/lib/approvals.ts` `loadApprovals`); event contents are not used. Debounced 150 ms.
- "Live" is shown only after Realtime's `system` message (`extension: 'postgres_changes', status: 'ok'`). Supabase's troubleshooting guide says `SUBSCRIBED` alone only means the socket is open and a change made in the gap can be missed. This caused the first e2e failure. If no system message arrives within 5 s, it is treated as live (Supabase's "weaker fallback").
- Safety nets: re-read every 30 s while not live, every 2 min while live, on return to the foreground (`visibilitychange`) and on `online`. Re-read once on becoming live.
- Screen: "Live" / "Connecting…" / "Live updates paused · checking every 30 seconds" indicator (`data-testid="live-status"`); new items marked **New** with a yellow ring for 60 s; `aria-live="polite"` on the list; waiting count (`data-testid="waiting-count"`) on the Approvals link (desktop and phone nav) and in the tab title, e.g. "(2) Agent Control Tower". The list loads for approvers and admins, or anyone on `/approvals`. The request page (`/approvals/requests/:id`) also re-reads on any change, so a decision by someone else shows without a reload.
- Tests: `db-tests/realtime.test.ts` (3), `src/lib/live.test.tsx` (5), `e2e/live.spec.ts` (desktop and phone: Ravi has Approvals open, the agent raises a £2m request through the API, the card must appear within 2 s without a page load, marked New, then Ravi rejects it to tidy up). Measured 23 Oct (time from the API reply to the card on screen): preview 0.8 s desktop / 0.3 s phone; dev site after the merge 1.3 s / 1.3 s. Under the 2 s target but with less headroom than the preview runs; if the e2e starts failing on time alone, look at network latency before the code.

### Phone alerts (task 2.6, done on branch, not yet on main)
- **Who gets an alert:** the people who may decide the request (`request_deciders`, same rules as `can_decide_request`): the assigned approver, or every active department approver when nobody is assigned; never the agent's owners/creator. When a request starts waiting ("Approval needed · REQ-…") and when `assigned_to` changes (escalation: "Escalated to you · REQ-…"; admin re-route). Body = the same headline as the app; tapping opens `/approvals/requests/<id>`.
- **Flow:** trigger → `push_outbox` → statement trigger `push_kick()` makes a one-time token (`pdt_…`, only its hash stored) and `net.http_post`s it to `<site>/api/v1/push/dispatch` after commit → the function answers 202 and, in `waitUntil`, calls `push_claim(token)` (returns due alerts, devices and the VAPID key; token works once, 10 min) → encrypts per device (RFC 8291, `functions-lib/webpush.ts`, Web Crypto only) with a VAPID JWT (RFC 8292) → `push_report(token, results)`: 2xx delivered, 404/410 device removed, other errors kept for retry. `pg_cron` job `push-retry` (every minute) re-kicks anything unsent after a minute; gives up after 5 tries. People with no device: closed at once ("No device has alerts switched on").
- **Keys:** VAPID key pair made by `scripts/push-setup.mjs` in the *Database migrations* workflow, stored only in `push_config` (no grants; `push_configure` executable by nobody but the workflow's postgres login). No secret in GitHub or Cloudflare. `ROTATE=true` makes new keys and deletes all devices (people turn alerts on again). The browser gets the public key via `push_public_key()`.
- **Extensions:** `pg_net` 0.20.4 and `pg_cron` 1.6.4 enabled on dev by the migration (verified 23 Oct). The migration skips them where unavailable (PGlite); tests stub `net.http_post` (harness) and record calls in `net.calls`.
- **App:** `public/push-sw.js` (imported into the generated service worker via `workbox.importScripts`) shows alerts and focuses/opens the task on tap. `AlertsCard` on the Approvals screen (approvers): Turn on alerts / Send a test alert / Turn off; "Install the app" when the browser offers it (`beforeinstallprompt`, captured in `main.tsx`); iPhone/iPad in a browser tab are told to add to Home Screen first (Apple: iOS/iPadOS 16.4+, Home Screen web apps only, no developer account, permission only from a tap; webkit.org/blog/13878). Installed apps show the waiting count on the icon (Badging API, from `LiveProvider`). Devices are stored per person (`push_subscriptions`, own rows readable, changes only through `push_subscribe`/`push_unsubscribe`).
- **Demo reset** (`90_reset.sql`) truncates `push_outbox` and `push_dispatch_tokens`; devices are kept.
- **Tests:** `db-tests/push.test.ts` (10), `functions/webpush.test.ts` (9: encryption decrypted by the independent `http_ece` library, VAPID signature verified with Node crypto, sender, dispatch), `src/lib/push.test.ts` (5), `src/components/AlertsCard.test.tsx` (4), `e2e/alerts.spec.ts` (project `push`: Google Chrome, **persistent profile**, windowed under xvfb; turns alerts on as Ravi, test alert and a real £2m request arrive as notifications, read via `registration.getNotifications()`). Measured 23 Oct on the preview: test alert 1.4 s, request alert 0.6 s.
- **Why the e2e is set up that way** (each was a failure first): open-source Chromium can't subscribe (no Google push keys) → `channel: 'chrome'`; Chrome refuses push in Playwright's normal incognito-like contexts ("Registration failed - permission denied") → `launchPersistentContext`; kept windowed with `--disable-background-networking` removed so Chrome can reach its push service.
- **Side effect to know:** anyone who turns alerts on as Ravi on dev gets an alert each time the e2e runs (it raises £2m requests for Ravi).

### Demo personas (seed data; passwords are not recorded here)
- Admin: `admin@northbridge.demo` (the user signs in as this).
- Others include Ravi Menon (Payments approver), Daniel Okafor (Payments Risk Lead, approver), Omar Farouk (approver for personal data), Sara (Commercial Lending), Olly Owner (owner who is also approver).
- The e2e test reads the demo password from the env var `DEMO_USER_PASSWORD` (a GitHub secret).

### Seeds
- Load via `seed-demo.yml` (runs 00, 02, 03, 04, 05 in one psql session; 01 first for personas). `reset: true` restores personas (active, `must_change_password` false, not banned, approver scopes, roles except admin's admin role), truncates routing, action requests and the registry tables, and restarts the request code sequence. It also deletes every agent API key on that database.
- **Every seed run (with or without reset) sets every `@northbridge.demo` password, including `admin@northbridge.demo`, to the `DEMO_USER_PASSWORD` secret.** A password changed by hand on demo is lost at the next seed.

---

## 8. Phase 2 status (current release)

| Task | What | Status |
|---|---|---|
| 2.1 | Action request API with idempotency | Done, on demo (22 Oct) |
| 2.2 | Autonomy and threshold decision | Done, on demo (22 Oct) |
| 2.3 | Routing matrix (rules, screen, reroute, preview) | Done, on demo (22 Oct) |
| 2.4 | Approver task screen: what the agent wants and why; approve, reject with reason, escalate | **Done**, on main and demo (22 Oct) |
| 2.5 | Live update of the approvals list | **Done**, on main (23 Oct); not on demo |
| 2.6 | Phone install and push notifications | **Done** on branch `claude/task-2.6-push-alerts` (dev database migrated), not yet merged to main |
| 2.7 | Approval emails | On hold: needs task 0.6 (DNS) |
| 2.8 | Decision callback to the agent | **Next** |
| 2.9 | SLA timers | Planned |
| 2.10 | Four-eyes approval for Critical | Planned |
| 2.11 | Log API and heartbeat | Planned |
| 2.12 | End-to-end test of the £2m payment | Planned |
| 2.13 | Appian simulator | **Done** (live, 15/15 checks) |

Example for 2.4 (from the user's own wording): "FX agent wants to release £2m to supplier X, because…" with approve, reject with reason, and escalate.

Next steps, in order:
1. With the user's go-ahead, merge `claude/task-2.6-push-alerts` into `main` (fast-forward). Check that the automatic *Database migrations* run's "Phone alerts" notice shows the main site again.
2. Ask the user to try alerts on their own phone (steps are in the 23 Oct conversation: Android Chrome directly; iPhone via Share → Add to Home Screen).
3. Release 2.5 and 2.6 to demo only when the user says so: *Database migrations* → demo (creates demo's own alert keys, points alerts at the demo site), then fast-forward `demo` to `main`. No reseed needed.
4. Build **task 2.8** (decision returned to the agent: status check and callback). 2.7 (emails) waits for task 0.6 (DNS). Then 2.9 to 2.12.

Earlier, not yet done:
- **Task 0.6**: email DNS for `notify.appbay.ai` at Porkbun (needs Porkbun access or a screenshot of the Resend records from the user).
- **Task 3.1**: Microsoft spike. Needs the user to create a free trial tenant, register an app, and give the Application (client) ID and Directory (tenant) ID. Then run `ms-spike.yml` and complete device-code sign-in. Second run for the audit query ID.
- **User action**: turn off open sign-ups in both Supabase projects (Authentication → Sign In / Providers → Email).
- **Before client demos**: the user runs *Seed demo data* on demo (with reset) to restore review counts and clear test agents.
- **Appian**: give NAP-002's key to Appbay after they register it in the Control Tower (planned 29 Oct).

---

## 9. Build plan (PDF)

- Latest PDF: `docs/build-plan/Agent_Control_Tower_Build_Plan.pdf` (updated 23 Oct 2026). The source now lives in the repo so it cannot be lost with a session: `docs/build-plan/build.py` holds all content and statuses (edit `UPDATED`, `TODAY` and the task rows), then run `python3 docs/build-plan/build.py && CHROMIUM_PATH=/opt/pw-browsers/chromium node docs/build-plan/print.mjs`. The earlier scratch-folder source (`parts_*.py`) was lost with its session; the 19 Oct version was rebuilt from the 15 Oct PDF's text. 22 Oct: fixed a bug where the Progress table printed raw badge HTML instead of a coloured status badge (it escaped an already-built badge); `table()` now accepts a `(text, kind)` pair in the Status column.
- Key dates in the plan: single release; **credible demo 20 Nov 2026**; **demo ready 15 Dec 2026**. Phases: 2 (15–28 Oct, incl. 2.13 simulator), 3 (platform connection and auto-discovery, 29 Oct–9 Nov), 4 (kill switch, enforcement and incidents, 10–20 Nov), 5 (alerts and routing, 23–26 Nov), 6 (evidence and dashboards, 27 Nov–7 Dec), 7 (demo data and rehearsal, 8–15 Dec).
- The plan has a feasibility section and a "two findings" callout. Keep both.
- Update the plan when tasks complete, and send the updated PDF to the user.

### Kill switch: what it can and cannot do (answer given to the user)
- **Instant** for agents connected through the API, the control endpoint, or the platform connection (e.g., Appian agents via the simulator endpoint).
- For agents the tower cannot reach (e.g., ChatGPT or Claude used directly), it records a request and the owner must act. Disabling credentials is a v2 idea.
- Platform kill switch is placed **before** enforcement in the plan because a kill needs the agent to be connected to the tower first.

---

## 10. Working pattern that has worked

1. Read the relevant code and this file before changing anything.
2. Make the change, add or update tests (db, unit, e2e as needed).
3. Run the local checks; commit to `main` only when asked, with the attribution lines the session gives.
4. Push → CI, deploy to dev, e2e and api-smoke run automatically. Check the results with the GitHub API (`gh api`) or the Actions page.
5. Report in plain words: what changed, what was tested, what the user must do. Release to `demo` only on their go-ahead.
6. Update the build plan PDF and this file when a task completes.

Pitfalls seen so far:
- Seed data that uses fixed dates drifts. Use relative dates.
- Duplicate seed rows on re-run: use "not exists" guards.
- e2e strict-mode failures from duplicate text (e.g., "Active" appears twice). Scope the locator to the panel.
- A race on the Users page was fixed by remounting the form per person (`key={id}`).
- Lint: `unicorn/no-invalid-fetch-options` flags a body on GET requests.
- The PGlite auth stub needs the extra `auth.users` columns (`banned_until` etc.) and `auth.identities`.
- Deleting a user in tests can fail if agents reference them; the reset truncates action requests first.
- `functions/api.test.ts` fails locally with "Cannot find module './config.js'" until you copy `functions-lib/config.example.js` to `functions-lib/config.js` (CI does this).
- The sandbox clone is shallow (`--depth 1`). Before pushing one branch onto another (e.g. `main` → `demo`), run `git fetch --depth=30 origin main:refs/remotes/origin/main demo:refs/remotes/origin/demo`, or `git merge-base --is-ancestor` wrongly says it is not a fast-forward. `gh api repos/.../compare/demo...main` gives the true ahead/behind count.
- From the sandbox, GitHub API writes to refs (`PATCH git/refs`) are refused by the proxy; use `git push`. Workflow job logs return 403, so read results from check-run annotations (`gh api repos/.../check-runs/<job id>/annotations`); `db-inspect.yml` puts its query result there. The sandbox cannot reach the Pages sites with curl (proxy 403); WebFetch works for `/api/v1/health`.
- Supabase Realtime: `SUBSCRIBED` does not mean changes will arrive yet; wait for the `system` message (see task 2.5). In tests, wait for the "Live" indicator before making the change.
- Playwright: after clicking a card that navigates, wait for something on the new page (e.g. `request-headline`) before clicking a button whose name also exists on the old page, or strict mode fails.
- Playwright report artifacts can't be downloaded from the sandbox (blob storage 403), the same as logs.
- An approver who escalates a request may lose sight of it (visibility comes from being assigned), so the screen returns to the list rather than reloading.

---

## 11. Quick reference

- Demo site: https://agent-control-tower-56p.pages.dev
- Dev site: https://main.agent-control-tower-56p.pages.dev
- Appian: https://appbay-demo.appiancloud.com
- Repo: github.com/Appbay-AI/agent-control-tower (branches `main`, `demo`)
- Supabase: `act-dev` (gprwtthwvmmmbslccxpf), `act-demo` (ekowumwkevkzwvkiljvf)
- This file: `HANDOVER.md` at the repo root (on `main`; last updated 23 Oct, on the 2.6 branch)
