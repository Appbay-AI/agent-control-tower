"""Builds the Agent Control Tower build plan as HTML (plan.html). print.mjs turns it into the PDF.

Run from the repo root:  python3 docs/build-plan/build.py && node docs/build-plan/print.mjs
Update UPDATED, TODAY and the task statuses below when a task completes.
Never change a task's planned dates (the user's rule, 26 Oct): the Dates column is the plan, even when a task finishes
early or late. Progress shows in the Status column and the notes.
"""
from datetime import date, timedelta
from html import escape
from pathlib import Path

UPDATED = 'Nov 3, 2026'
TODAY = date(2026, 11, 3)
OUT = Path(__file__).with_name('plan.html')

# ---------------------------------------------------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------------------------------------------------
START, END = date(2026, 10, 1), date(2026, 12, 17)
# (label, start, end, kind) kind: done | new | extended | original | gate | milestone
BARS = [
    ('0 Setup', date(2026, 10, 1), date(2026, 10, 2), 'done'),
    ('1 Registry', date(2026, 10, 5), date(2026, 10, 9), 'done'),
    ('Go/no-go gate', date(2026, 10, 12), date(2026, 10, 14), 'gate'),
    ('2 Approval engine', date(2026, 10, 15), date(2026, 10, 28), 'original'),
    ('2.13 Appian simulator', date(2026, 10, 16), date(2026, 10, 23), 'done'),
    ('3 Platform connection', date(2026, 10, 29), date(2026, 11, 9), 'new'),
    ('4 Kill switch, enforcement', date(2026, 11, 10), date(2026, 11, 20), 'extended'),
    ('Credible demo', date(2026, 11, 20), None, 'milestone'),
    ('5 Alerts, routing', date(2026, 11, 23), date(2026, 11, 26), 'new'),
    ('6 Evidence, dashboards', date(2026, 11, 27), date(2026, 12, 7), 'extended'),
    ('7 Demo data, rehearsal', date(2026, 12, 8), date(2026, 12, 15), 'extended'),
    ('Demo ready', date(2026, 12, 15), None, 'milestone'),
]
TICKS = [date(2026, 10, 1), date(2026, 10, 15), date(2026, 10, 29), date(2026, 11, 12), date(2026, 11, 26), date(2026, 12, 10)]

# ---------------------------------------------------------------------------------------------------------------------
# Phases and tasks. status: Done | Next | Planned | Waiting on DNS | (blank)
# ---------------------------------------------------------------------------------------------------------------------
PHASES = [
    {
        'title': 'Phase 0 — Setup', 'dates': '1–2 Oct (2 days)', 'badge': ('Done except 0.6', 'done'),
        'intro': 'Everything needed before the first feature is written.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when', 'Status'],
        'rows': [
            ('0.1', 'Create accounts: GitHub, Supabase, Cloudflare, Resend', 'All', '1 Oct', 'Team can log in to all four', 'Done'),
            ('0.2', 'Create repo, React + Vite + TypeScript app, Tailwind and shadcn/ui', 'TypeScript, React', '1 Oct', 'Blank app runs in the cloud', 'Done'),
            ('0.3', 'Two Supabase projects: development and demo', 'Supabase', '1 Oct', 'Both projects reachable', 'Done'),
            ('0.4', 'Deploy app to Cloudflare Pages from the repo', 'Cloudflare Pages', '2 Oct', 'Every push shows a live link', 'Done'),
            ('0.5', 'Automated checks on every change; Supabase keep-alive ping', 'GitHub Actions, Vitest', '2 Oct', 'Checks run on each push', 'Done'),
            ('0.6', 'Verify email sending domain notify.appbaytech.com (DNS records at Hostinger)', 'Resend', '2 Oct', 'Test email arrives', ('On hold', 'wait')),
        ],
    },
    {
        'title': 'Phase 1 — Registry', 'dates': '5–9 Oct (5 days)', 'badge': ('Done', 'done'),
        'intro': 'The foundation: every agent recorded, owned and approved before it goes Live.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when', 'Status'],
        'rows': [
            ('1.1', 'Database tables: agents, owners, action requests, approvals, incidents', 'Supabase Postgres', '5 Oct', 'Tables created from a script', 'Done'),
            ('1.2', 'Insert-only, hash-chained audit log (edits and deletes blocked)', 'Postgres triggers', '5–6 Oct', 'An edit attempt is refused', 'Done'),
            ('1.3', 'Login and roles: approver, owner, executive, auditor, admin', 'Supabase Auth + RLS', '6 Oct', 'Each role sees only its scope', 'Done'),
            ('1.4', 'Agent registry screens: list, detail, add and edit', 'React, TypeScript', '6–7 Oct', 'All registry fields captured', 'Done'),
            ('1.5', 'Registration approval: Proposed → Approved → Live, blocked without owner and purpose', 'Postgres functions', '7–8 Oct', 'No agent reaches Live without both', 'Done'),
            ('1.6', '6-month review date and overdue-review alert', 'pg_cron', '8 Oct', 'Overdue agent is flagged', 'Done'),
            ('1.7', 'Register API for agents, with API key per agent', 'Cloudflare Functions', '8–9 Oct', 'Script registers an agent', 'Done'),
            ('1.8', 'Phase 1 demo build for the partner meetings', 'All', '9 Oct', 'Registry shown end to end', 'Done'),
            ('1.9', '<b>Added:</b> Users screen: add people, set roles and approval departments, reset passwords, deactivate', 'React, Postgres', '8 Oct', 'Admin onboards a person without code', 'Done'),
        ],
    },
    {
        'title': 'Go/no-go gate', 'dates': '12–14 Oct (3 days)', 'badge': ('Go', 'done'),
        'intro': 'The requirements make this mandatory: show the concept to three existing clients before building past Phase 1. If none react, we stop.',
        'cols': ['#', 'Task', 'Who', 'Dates', 'Done when'],
        'rows': [
            ('G.1', 'Book and hold three design-partner conversations', 'Sales lead', '12–14 Oct', 'Three meetings held'),
            ('G.2', 'Record what each client says they actually need', 'Sales lead', '12–14 Oct', 'Notes shared with team'),
            ('G.3', 'Go/no-go decision', 'Leadership', '14 Oct', 'Decision written down'),
        ],
        'outro': 'Outcome: go, with Microsoft Copilot auto-discovery and platform enforcement added to the scope (Phase 2 requirements, 14 Oct). During the gate the team also wrote the demo bank seed script (task 7.1, done) and the meeting guide.',
    },
    {
        'title': 'Phase 2 — Approval engine', 'dates': '15–28 Oct (10 days)', 'badge': ('Done', 'done'),
        'intro': 'The heart of the product: an agent above its threshold waits for a named human. Unchanged, except that the Appian agent-platform simulator is built alongside it. Tasks 2.1 to 2.4 were released to the client demo on 22 Oct and 2.5 to 2.9 on 26 Oct; later tasks reach it only when released.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when', 'Status'],
        'rows': [
            ('2.1', 'Action request API with duplicate protection (idempotency keys)', 'Cloudflare Functions, Postgres', '15–16 Oct', 'Same request twice is processed once', 'Done'),
            ('2.2', 'Autonomy and threshold check (Levels 1–4); suspended agents fail closed', 'Postgres functions', '16–19 Oct', 'Each level behaves as specified', 'Done'),
            ('2.3', 'Routing matrix, editable from a screen without code', 'Postgres, React', '19–20 Oct', 'Changing an approver needs no deploy', 'Done'),
            ('2.4', 'Approver task screen: what the agent wants and why; approve, reject with reason, escalate', 'React, TypeScript, Postgres', '20–22 Oct', 'Decision saved and logged', 'Done'),
            ('2.5', 'Task appears live on screen', 'Supabase Realtime', '22 Oct', 'Task raised within 2 seconds', 'Done'),
            ('2.6', 'Phone install and push alerts', 'vite-plugin-pwa, Web Push', '22–23 Oct', 'Alert arrives on a phone', 'Done'),
            ('2.7', 'Approval emails (temporary mode until 0.6: every email goes to one Appbay inbox)', 'Resend', '23 Oct', 'Approver gets an email', 'Done'),
            ('2.8', 'Decision returned to the agent (status check and callback)', 'Cloudflare Functions', '26 Oct', 'Demo agent proceeds on approval', 'Done'),
            ('2.9', 'SLA timer: escalate to next approver or auto-reject (default)', 'pg_cron', '26–27 Oct', 'Overdue task escalates or rejects', 'Done'),
            ('2.10', 'Four-eyes approval for Critical agents; bulk approval for low-risk', 'Postgres, React', '27 Oct', 'Both work and are logged', 'Done'),
            ('2.11', 'Log API and silent-agent (heartbeat) check', 'Cloudflare Functions, pg_cron', '28 Oct', 'Silent agent is flagged', 'Done'),
            ('2.12', 'End-to-end test of the £2m payment on desktop and phone', 'Playwright', '28 Oct', 'Test passes on every change', 'Done'),
            ('2.13', '<b>New:</b> Build the demo agent platform in Appbay\'s Appian environment ("Northbridge Agent Platform (simulated)", never shown as Microsoft): agents table, a screen to add or switch an agent back on, web APIs to list agents, read and set status, and two demo agents that check their status before every action', 'Appian (Web APIs, data store)', '16–23 Oct', 'Control Tower can list, block and unblock agents through the APIs; a blocked demo agent stops', 'Done'),
        ],
        'outro': 'Notes on progress. 2.3: rules match on agent, department, value band, data touched and risk tier; a rule never assigns the agent\'s own owner. 2.4: the assigned approver (or any department approver when no rule matched) approves, rejects with a reason or escalates to another approver with a reason; an agent suspended since it asked can only be rejected; every step is in the audit trail; the agent reads the decision through the API. 2.5: a new task reaches an approver\'s open screen in under a second in the browser test (0.8 s desktop, 0.3 s phone; target 2 s), marked New, with a waiting count on the Approvals link; if the live link drops the list is re-read every 30 seconds, so nothing is missed. Uses Supabase Realtime on the free plan (200 connections, 2 million messages a month). 2.6: an approver can turn alerts on for a phone or browser from the Approvals screen; when an agent action waits for them (or is escalated to them) the alert arrives with the app closed, and tapping it opens the task. Android and desktop browsers work directly; iPhone and iPad need the app added to the Home Screen (iOS 16.4 or later, Apple\'s rule). In the browser test, in Google Chrome, the alert for a £2m request arrived in 0.6 s. Free: browsers\' own push services, no new account or secret; signing keys stay in the database. 2.7: approvers are emailed when an action waits for them or is escalated to them (what, how much, why, a link to the task); each request shows who was told and whether it was sent. Until the email domain (0.6) is verified, emails come from Resend\'s test sender and all go to one Appbay inbox, marked with who they were for; the demo keeps that inbox anyway, because the demo people\'s addresses are not real mailboxes. Free: Resend\'s free plan (3,000 emails a month, 100 a day). 2.8: when a person decides, the Control Tower calls the agent back with the decision, signed with the agent\'s own key so the agent can tell it is genuine (no new secret), and retries for about an hour and a half if the agent does not answer; agents can still ask for the decision at any time. An agent console (admins) plays the Payment Release Assistant for demos: in the browser test it heard the approval, checked the signature and went ahead 1.4 s after the person approved. Integrator guide: docs/agent-api.md. 2.9: every waiting request has a time to decide (by default 30 minutes for critical, 2 hours high, 8 hours normal, 24 hours low; a rule can set its own); when it passes, the request goes once to a named next approver if the rule says so, otherwise it expires and the agent is told no. Admins set the times on the Routing screen; approvers see "Decide within …". Checked in real time in the browser test: escalated after 1¾ minutes, expired a minute later. Also fixed: a routing rule could not be deleted once it had routed a request that was later decided. 2.10: an action by a Critical agent (such as the Payment Release Assistant) needs two different approvers: the first approval keeps it waiting and alerts the others ("Second approval needed"); the second decides it; one rejection ends it. Approvers can also tick several low-risk requests and approve them together, each still decided and recorded on its own; the demo data now has three Branch Rota Planner requests for Omar Farouk to show this. The browser test covers the £2m payment from request to approval, ahead of 2.12. 2.11: agents write what they did to the Control Tower\'s log and check in through the API; every call an agent makes with its key counts as being heard from. An agent\'s owner or an admin can ask for it to be watched ("flag if silent for more than 1 hour"); a check every minute flags a Live agent that has gone quiet, on its page and in a new Silent count on the registry, and the flag clears as soon as the agent is heard from again. Log entries cannot be edited or deleted and are kept for 90 days. In the browser test an agent with a 1-minute limit was flagged 81 seconds after its last check-in, and cleared at once when it checked in again. The demo data has a silent Cash Forecast Agent and a log for the £2m payment. Integrator guide: docs/agent-api.md. 2.12: one browser test now plays the whole £2m payment as the client will see it, on a desktop and on a phone: the agent checks it may act, checks in and logs its work; asks to release £2,000,000 (asking twice does not make a second payment); the task appears on Ravi Menon\'s open list without a reload; he reads what, how much, why and by when, and approves first; Daniel Okafor gives the second approval in his own browser; the agent is told it may go ahead and logs the release against the request. It runs after every change to the work-in-progress site. In the last run the task was on Ravi\'s screen 0.96 s (desktop) and 0.88 s (phone) after the agent asked, and the agent had its answer about 2.2 s after the second approval. The live-list check (2.5) is now timed inside the page, when the task actually appears; it had been timed by the test\'s own re-checks, which can add up to a second. The 2-second target is unchanged, and the report now says where the time goes (the message reaching the screen, then reading the list again). 2.13: the simulator passes 15 of 15 acceptance checks.',
    },
    {
        'title': 'Phase 3 — Agent-platform connection and auto-discovery', 'dates': '29 Oct – 9 Nov (8 days)', 'badge': ('In progress', 'now'),
        'intro': 'New. Platform agents arrive in the registry on their own, so the kill switch in Phase 4 has something real to act on. The demo uses an Appian simulator; the Microsoft plug-in is built to Microsoft\'s documented APIs and verified on a client tenant in the pilot. ChatGPT, Claude and GitHub Copilot agents keep the manual intake form.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when'],
        'rows': [
            ('3.1', '<b>New:</b> Spike on a free 30-day Microsoft 365 trial (recurring billing off): run the Microsoft spike workflow to confirm sign-in renewal, agent list fields, block and unblock on unpublished agents, Entra fields and audit records', 'Power Platform APIs, Entra ID, GitHub Actions', '29 Oct–2 Nov', 'Written answers for the Microsoft plug-in; no cost'),
            ('3.2', '<b>New:</b> Platform plug-in interface (list agents, read status, block, unblock), with two plug-ins: Appian simulator (used for the demo) and Microsoft Copilot Studio (built to Microsoft\'s documented APIs: admin signs in once, sign-in renewed automatically and kept server-side)', 'TypeScript, Supabase Vault', '3 Nov', 'Both plug-ins pass the same tests; switching platform needs no code change'),
            ('3.3', '<b>New:</b> Scheduled fetch every 5 minutes and a "Sync now" button: the database scheduler calls our Cloudflare API in batches of up to 40 agents (the free plan allows 50 outgoing calls per request). On Microsoft, its own list lags about 20 minutes (R1.1)', 'pg_cron + pg_net, Cloudflare Functions', '4 Nov', 'Agent added in the platform appears in the registry'),
            ('3.4', '<b>New:</b> Capture owner, environment, maker, blocked status, last published, channels, tools and sharing; usage as sessions and last active (30 days) only where Microsoft provides it; job title and department from Entra ID (R1.2, R1.3)', 'Power Platform APIs, Microsoft Graph', '5 Nov', 'All fields Microsoft provides are stored'),
            ('3.5', '<b>New:</b> Ungoverned agents enter as Discovered and must pass the Phase 1 registration approval; owner and designated person alerted (R1.4)', 'Postgres, React', '6 Nov', 'Shadow agent cannot reach Live unapproved'),
            ('3.6', '<b>New:</b> Dual registry: source badge (platform name (auto) or Manual); platform fields read-only, governance fields editable (R1.5, R1.6)', 'React, Postgres', '9 Nov', 'Platform fields cannot be edited'),
        ],
        'outro': 'Notes on progress. 3.1: deferred on 29 Oct by decision (no Microsoft 365 trial for now); the Microsoft plug-in will be checked on a client tenant in the pilot. A trial could not have tested blocking published agents anyway, because a trial cannot publish. 3.2: done for the Appian simulator on 29 Oct, ahead of its 3 Nov date, and on the work-in-progress site; the Microsoft plug-in waits for 3.1. Control Tower talks to every platform through one interface (list agents, read status, block, unblock), and the plug-in is chosen by the stored connection, so switching platform needs no code change. One set of tests (the contract) must pass for every plug-in; the Appian plug-in passes it on a stand-in built from the simulator spec and against the real simulator (7 of 7). It never guesses: an answer that breaks the contract counts as a failure, so the kill switch will never believe an agent is blocked unless the platform clearly says so. The Appian key goes from GitHub\'s secret store straight into the database and is used only by our server, never a browser (the same way as the email key, rather than Supabase Vault, so it can be tested). Admins see the connection on the Integrations page and can press Test connection: it found the simulator\'s 8 agents (1 blocked, 1 without an owner) in a quarter of a second. Also fixed while testing: the Approvals screen\'s read of earlier approvals checked every action request ever made and was getting slower with each one (2.6 s on the test site); it now takes 11 ms in the database, and the 2-second live-list test passes again (1.8 s desktop, 1.6 s phone on a slow day). 3.3: done on 29 Oct, on the work-in-progress site since 30 Oct. By decision the agent list is fetched every 30 minutes by default instead of every 5, to keep load off the Appian server; admins can change it (5 minutes to a day, or off) and press Sync now at any time. Each sync stores every agent the platform lists; agents no longer listed are marked missing at source, and agents found, missing, back again, or blocked or unblocked on the platform are written to the audit trail. Found agents are listed on the registry page (for admins, executives and auditors) as not yet governed; making them governed entries is 3.5. On the test site the first automatic sync found the simulator\'s 8 agents by itself. One consequence for 4.7: re-blocking an agent switched back on in the platform could take up to 30 minutes unless reconciliation checks blocked agents more often; to be decided in 4.7. A sync makes one call to the platform; batching (planned for the free plan\'s 50 outgoing calls) matters only for Microsoft, where status is read per agent. 3.4: not needed for Appian, whose fields are already stored with each agent; the Microsoft and Entra fields wait for 3.1. 3.5: done on 30 Oct, on its branch. Every agent a sync finds that is not governed enters the registry as Discovered, with what the platform said (owner and department where they match people and departments in Control Tower); its purpose is left blank for a person to write. It then follows the Phase 1 rules unchanged, so it cannot go Live until an approver has approved it. An agent already registered by hand under the same name and owner is linked instead of duplicated (the Invoice Matcher). Each discovered agent carries a "not registered" alert until it is approved or retired, and each admin, and its owner, gets a phone alert (emails come with alert routing in Phase 5). 3.1: on 30 Oct Microsoft was tried in a colleague\'s account, then set aside by decision: the product stays Appian-only for now. 3.6: done on 2 Nov, on its branch. Each agent shows where it comes from: the platform\'s name (auto), API or Manual, with a filter. For agents from a platform, the name, description, systems and data types follow the platform on every sync and cannot be edited in Control Tower; owners, purpose, limits, risk and the rest remain Control Tower\'s to set.',
    },
    {
        'title': 'Phase 4 — Kill switch, enforcement and incidents', 'dates': '10–20 Nov (9 days)', 'badge': ('In progress', 'now'),
        'intro': 'Extended. Suspending a platform agent now stops it inside its platform, and keeps it stopped if someone switches it back on. At the end of this phase the credible demo exists.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when'],
        'rows': [
            ('4.1', 'Kill switch: one action, reason required, second approver option for Critical', 'React, Cloudflare Functions', '10 Nov', 'Agent suspended in under 30 seconds'),
            ('4.2', '<b>Extended:</b> Enforcement by source: platform agents (Appian simulator, Microsoft) are blocked through the platform API and read back; agents that call our API are refused at their next status check or action request; agents with a control endpoint get a stop webhook; agents we cannot reach get an email asking the owner to disable them (R2.1, R2.4)', 'Platform plug-ins, Cloudflare Functions, Resend', '11 Nov', 'Each kind of agent stops, or its owner is told to stop it'),
            ('4.3', '<b>New:</b> If the API call fails: stay Suspended, mark Enforcement pending, retry, alert admins (R2.2)', 'Cloudflare Functions, pg_cron', '12 Nov', 'Failed call retried until it works'),
            ('4.4', 'Incident case opens automatically; manual incident report API', 'Postgres triggers, Cloudflare Functions', '12 Nov', 'Incident appears with owner and SLA'),
            ('4.5', 'Incident screens: impact, containment, root cause, remediation', 'React, TypeScript', '13 Nov', 'All case fields captured'),
            ('4.6', '<b>Extended:</b> Reactivation approval (never a toggle); only after approval, un-quarantine in Microsoft (R2.3)', 'Cloudflare Functions, React, quarantine API', '16 Nov', 'Agent returns to Live only via approval'),
            ('4.7', '<b>New:</b> Reconciliation loop: desired vs observed state, checking each governed agent\'s blocked status directly; if someone switches it back on in the platform, re-block and open an incident; fail closed; mark Missing at source (R3.1–R3.4)', 'pg_cron + pg_net, Cloudflare Functions, platform plug-ins', '17–18 Nov', 'Agent switched back on in Appian is re-blocked within one cycle'),
            ('4.8', '<b>New:</b> Data-authority matrix (which roles may see which data); owner and sharing changes audited and checked (R3.5)', 'Postgres, React', '18 Nov', 'New user without authority raises an alert'),
            ('4.9', '<b>Extended:</b> Rules: Critical incident auto-suspends; closure needs a named approver; repeat incidents, or 3 reactivations outside Control Tower, force a review; every drift recorded with expected, observed, actor ("unknown, outside Control Tower" unless the spike finds a source), action, result (R3.6, R3.7)', 'Postgres, pg_cron', '19 Nov', 'Each rule proven by a test'),
            ('4.10', '<b>Extended:</b> Credible-demo checkpoint', 'All', '20 Nov', 'Register, live approval, kill switch in the agent platform and re-block shown end to end'),
        ],
        'outro': 'Notes on progress. 4.1: done on 2 Nov, ahead of its 10 Nov date, on its branch. Admins, an agent\'s owners and approvers for its department can suspend a Live agent in one action, with a reason; from that moment every check the agent makes with the Control Tower is refused, and what it was waiting for can no longer be approved. In the browser test the agent was refused at its next check within the same second (target: 30 seconds). Admins can choose to require a second person for Critical agents; the others who may confirm are alerted on their phones. Every press is on the record. 4.2: done on 3 Nov, ahead of its 11 Nov date, on its branch. When an agent is suspended, the Control Tower stops it every way it can reach it and shows each step on the agent\'s page: an agent on Appian is blocked there and read back (it counts only if Appian then says it is blocked; in the browser test this took under half a second); an agent that calls our API is refused from that moment; an agent with a control endpoint is sent a signed stop request; and an agent we cannot reach at all gets an email to its owner (or to every admin if it has none) asking them to switch it off. Each step is tried once; retrying failed steps and alerting admins is 4.3. Also fixed: the live approvals list had started missing its 2-second target on slow days; it now reads fewer lists on each live update (1.7 s desktop, 0.5 s phone in the last test). Microsoft is waiting for a management decision; the kill switch is written so a Microsoft connection can be added later without rework. 4.3: done on 4 Nov, ahead of its 12 Nov date, and on the work-in-progress site. If a step fails (for example Appian does not answer), the agent stays Suspended, the step is marked as waiting to be tried again, and it is retried after 1, 2, 5, 15 and 30 minutes, then every hour, until it works. Admins get one alert (on their phones too) saying what has not worked and when the next try is; it clears itself once the agent is stopped. Failures that trying again cannot fix (the agent no longer exists on the platform, an email address that is refused) are marked Failed and the alert says a person needs to act. In the test, Appian was made unreachable for the test database, an agent was suspended, and the block was kept for a retry with the admins alerted; when Appian came back, the retry blocked the agent there 75 seconds later and the alert cleared. 4.4: done on 4 Nov, ahead of its 12 Nov date, on its branch. Suspending an agent now opens an incident case by itself; agents and connected systems can also report one through the API (a retry never opens a second). Every incident has an owner (the agent\'s business owner, else its technical owner, else whoever raised it, else an admin), who is alerted on their phone, and a time by which it should be resolved, set by severity (Critical 4 hours, High 1 day, Medium 3 days, Low 7 days; admins can change these). A new Incidents page lists them, open and overdue first; each agent\'s page shows its own. The plan\'s 1.1 line listed an incidents table, but it had not been built; it was created now.',
    },
    {
        'title': 'Phase 5 — Alerts and routing', 'dates': '23–26 Nov (4 days)', 'badge': ('Planned', 'plan'),
        'intro': 'New. The right person hears about every change, with enough detail to act.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when'],
        'rows': [
            ('5.1', '<b>New:</b> Alerts for suspended, reactivated, re-quarantined, enforcement pending, discovered, missing at source and PII mismatch; email carries owner, users with role and department, data touched and the PII red flag (R4.1, R4.2)', 'Resend', '23–24 Nov', 'Each event sends the specified email'),
            ('5.2', '<b>New:</b> Alert routing: default (designated person and admins), then department, then agent rules, edited on a screen; reuses the 2.3 pattern (R4.3)', 'Postgres, React', '24–25 Nov', 'Changing a route needs no deploy'),
            ('5.3', '<b>New:</b> Emails link to the reactivation approval task; a reply email is never a decision (R4.4)', 'React', '25 Nov', 'Decision only through the app'),
            ('5.4', '<b>New:</b> In-app notification alongside every email (R4.5)', 'Supabase Realtime', '26 Nov', 'Notification within 2 seconds'),
        ],
    },
    {
        'title': 'Phase 6 — Evidence pack, dashboards and reports', 'dates': '27 Nov – 7 Dec (7 days)', 'badge': ('Planned', 'plan'),
        'intro': 'The proof for auditors and the view for executives, now including what happened in Microsoft.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when'],
        'rows': [
            ('6.1', '<b>Extended:</b> Evidence pack: pick a date range, one click, PDF; adds drift events, re-quarantine actions and sync history (R5.5)', 'pdfmake', '27–30 Nov', 'PDF holds inventory, approvals, incidents, autonomy changes, reviews, kill-switch events, drift, sync history, attestation'),
            ('6.2', 'Same evidence pack as Excel', 'ExcelJS', '30 Nov', 'Excel matches the PDF'),
            ('6.3', '<b>Extended:</b> Executive dashboard: agents by risk tier and by source (auto vs manual coverage), no owner, overdue reviews, open incidents, pending approvals, average approval time (R5.3)', 'Recharts', '1 Dec', 'Loads in under 3 seconds'),
            ('6.4', 'Risk dashboard: heat map by department and tier, breach trend, top agents by incidents', 'Recharts', '2 Dec', 'Figures match the data'),
            ('6.5', 'Operational dashboard: my approvals, my agents, SLA breaches', 'React', '2 Dec', 'Each user sees only their own'),
            ('6.6', '<b>New:</b> Drift report (every out-of-band change by agent, actor, date and action) and sync health (last sync, failures, agents seen, new or changed) (R5.1, R5.2)', 'React, Postgres', '3 Dec', 'Reports match the records'),
            ('6.7', '<b>New:</b> PII-access mismatch report (R5.4)', 'React, Postgres', '4 Dec', 'Mismatches listed with roles'),
            ('6.8', 'Audit view: searchable audit trail with export', 'React, Postgres', '7 Dec', 'Any event found and exported'),
        ],
    },
    {
        'title': 'Phase 7 — Demo data, polish and rehearsal', 'dates': '8–15 Dec (6 days)', 'badge': ('Planned', 'plan'),
        'intro': 'The data must tell a story, not look healthy, in Control Tower and in the Appian simulator.',
        'cols': ['#', 'Task', 'Tech', 'Dates', 'Done when'],
        'rows': [
            ('7.1', '<b>Extended:</b> Synthetic bank: 40 agents, 6 without owners, 4 overdue reviews, 1 open incident, 1 shadow vendor agent, 12 months of history; plus agents in the Appian simulator, including one shadow agent. Since 19 Oct it also leaves the £2m payment request waiting in Ravi Menon\'s queue', 'SQL seed script, Appian', 'Done 7 Oct; final 8 Dec', 'Database and simulator rebuilt in one command'),
            ('7.2', 'Demo agents, including the £2m payment request', 'Python / LangGraph scripts', '8 Dec', 'Payment triggered on cue'),
            ('7.3', '<b>New:</b> End-to-end test of the platform story: discover, suspend, demo agent stops, switched back on in Appian, re-block, incident, email, drift report', 'Playwright', '9 Dec', 'Passes on every change'),
            ('7.4', 'Polish: phone layout, loading speed, wording', 'React, Tailwind', '10 Dec', 'Playwright passes on phone and desktop'),
            ('7.5', '<b>Extended:</b> Write the demo script (now about 25 minutes, with the Microsoft re-block)', 'Team', '10 Dec', 'Script matches both requirement documents'),
            ('7.6', 'Two full rehearsals, fix what breaks', 'Team', '11–14 Dec', 'Kill switch under 30 seconds every time'),
            ('7.7', 'Demo ready', 'All', '15 Dec', 'Both definitions of done met'),
        ],
    },
]

PROGRESS = [
    ('Phase 0 — Setup', '1–2 Oct', ('Done except 0.6', 'done'), 'Email domain (appbaytech.com, at Hostinger) waits on DNS records.'),
    ('Phase 1 — Registry', '5–9 Oct', ('Done', 'done'), 'Plus a Users screen (1.9), not in the original plan.'),
    ('Go/no-go gate', '12–14 Oct', ('Go', 'done'), 'Microsoft Copilot scope added.'),
    ('Phase 2 — Approval engine', '15–28 Oct', ('Done', 'done'),
     '2.1 to 2.12 and the Appian simulator (2.13) done, on schedule. 2.1 to 2.9 are on the client demo (released 26 Oct), with the £2m payment request waiting for Ravi Menon; phone alerts were confirmed on a real phone. 2.7 (approval emails) works in temporary mode until the email domain is verified. 2.10 (four-eyes and bulk approval) is on the work-in-progress site; 2.11 (log API and silent-agent check) is on the work-in-progress site; 2.12 (the £2m payment test on desktop and phone) passes there on every change. Phase 2 is complete. Next: Phase 3, starting with the Microsoft spike (3.1).'),
    ('Phase 3 — Platform connection', '29 Oct – 9 Nov', ('In progress', 'now'), '3.1 (Microsoft) waiting for a management decision; Appian only for now. 3.2, 3.3 and 3.5 on the client demo since 30 Oct, 3.6 on the work-in-progress site. 3.4 not needed for Appian.'),
    ('Phase 4 — Kill switch', '10–20 Nov', ('In progress', 'now'), '4.1 (kill switch) on the work-in-progress site since 2 Nov; 4.2 (stop the agent in Appian, by API, stop request or owner email) on main since 4 Nov; 4.3 (retries and admin alerts) on main since 4 Nov; 4.4 (incident case and report API) done on its branch on 4 Nov. Next: 4.5 (incident screens).'),
    ('Phases 5–7', '23 Nov – 15 Dec', ('Planned', 'plan'), 'Seed data (7.1) already done.'),
]

CHANGES = [
    ('Phase 3 — Agent-platform connection and auto-discovery', 'New phase, before the kill switch', '+8 days'),
    ('Phase 4 — Kill switch and incidents (was Phase 3)', 'Enforces in Microsoft, re-blocks, data-authority check', '+4 days'),
    ('Phase 5 — Alerts and routing', 'New phase', '+4 days'),
    ('Phase 6 — Evidence and dashboards (was Phase 4)', 'Drift, sync health, source and PII reports', '+2 days'),
    ('Phase 7 — Demo data and rehearsal (was Phase 5)', 'Simulator data and end-to-end test', '+2 days'),
    ('Phase 2 — Approval engine', 'Appian simulator built by the Appian team (no extra build days)', '+0 days'),
    ('<b>Total</b>', '<b>20 working days added</b>', '<b>Demo 17 Nov → 15 Dec</b>'),
]

REQ_CHANGES = [
    ('R1.1 Fetch every 5 minutes', 'Changed 29 Oct by decision: every 30 minutes by default, adjustable from 5 minutes to a day, plus Sync now, to keep load off the platform\'s server. On Microsoft, new agents also appear about 20 minutes after creation (Microsoft\'s delay).'),
    ('R1.2 Agent fields', '"Scheduled or ad hoc" dropped; usage shown as sessions and last active (30 days) where Microsoft provides it.'),
    ('R3.2 Owner reactivates', 'Only admins can unblock in Microsoft, so the case is "an admin unblocks it outside Control Tower".'),
    ('R3.6 Record the actor', 'Recorded as "unknown, outside Control Tower" unless the spike finds a source.'),
]

FEASIBILITY = [
    ('Possible:', 'fetching Copilot Studio agents with owner, environment, blocked status, channels, tools and sharing; job title and department from Entra ID; blocking, unblocking and checking an agent with the quarantine API; re-blocking within one 5-minute cycle.'),
    ('Signed-in admin only.', 'Both the agent list and the quarantine API accept only a signed-in admin (Global, AI or Power Platform admin); an app acting on its own is refused. A client admin signs in once and the sign-in is renewed automatically (Microsoft gives it a 90-day lifetime that renews with use). This is the main point for bank security teams.'),
    ('New agents appear late.', 'Microsoft\'s agent list updates within about 20 minutes and shows only published versions.'),
    ('Who reactivated is not available.', 'Copilot Studio\'s audit log lists no quarantine events, so drift records show the actor as unknown unless the spike finds a source.'),
    ('Usage is limited', 'to sessions and last activity over 30 days. "Scheduled or ad hoc" is not in Microsoft\'s data. Classic chatbots cannot be listed or blocked.'),
    ('Free stack holds, Microsoft side does not.', 'Supabase, Cloudflare and Resend free tiers cover the work, with sync batched to Cloudflare\'s 50 calls per request. A real Microsoft demo needs a paid Copilot Studio licence, so the demo runs on an agent-platform simulator in Appbay\'s Appian environment and the Microsoft plug-in is checked on a free 30-day trial (3.1).'),
]

RISKS = [
    ('The demo is not Microsoft.', 'The demo platform is an Appian simulator and must be named as one. The Microsoft plug-in is proven only on a free trial with unpublished agents until a client pilot; say so if a bank asks.'),
    ('The admin sign-in.', 'If a client\'s security policies end the stored admin sign-in, sync and enforcement stop until an admin signs in again; agents stay blocked (fail closed) and admins are alerted.'),
    ('The spike (3.1) may change Phase 3.', 'If the answers to the open questions are unfavourable (for example, no reliable way to name who reactivated an agent), the affected tasks shrink to what Microsoft supports rather than pushing the date.'),
    ('Diwali (around 8 Nov) now falls inside Phase 3.', 'If the team takes leave, that phase slips by the days lost.'),
    ('DNS access for email (0.6) is still open.', 'Until it is done, every email goes to one Appbay inbox (2.7 temporary mode); owner emails (4.2) and Phase 5 alerts need it to reach real people. It needs whoever holds the Hostinger login for appbaytech.com (about 10 minutes, three records).'),
    ('Bank security reviews.', 'Clients must grant our app high-privilege admin consent in Microsoft. Expect weeks per client; it does not block the demo.'),
    ('Scope creep.', 'Anything else a client asks for goes on a v2 list, not into this plan.'),
]

# ---------------------------------------------------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------------------------------------------------
STATUS_KIND = {'Done': 'done', 'Next': 'now', 'Planned': 'plan', 'Waiting on DNS': 'wait'}


def pill(text, kind):
    return f'<span class="pill {kind}">{escape(text)}</span>'


def chip(text):
    return f'<span class="chip">{escape(text)}</span>'


def table(cols, rows, widths=None):
    head = ''.join(f'<th>{escape(c)}</th>' for c in cols)
    body = []
    for r in rows:
        cells = []
        for i, c in enumerate(r):
            if cols[i] == 'Status':
                # A (text, kind) pair sets the colour itself; plain text takes it from STATUS_KIND.
                cells.append(f'<td>{pill(*c) if isinstance(c, tuple) else pill(c, STATUS_KIND.get(c, "plan"))}</td>')
            else:
                cells.append(f'<td>{c}</td>')
        body.append('<tr>' + ''.join(cells) + '</tr>')
    cg = ''.join(f'<col style="width:{w}">' for w in widths) if widths else ''
    return f'<table><colgroup>{cg}</colgroup><thead><tr>{head}</tr></thead><tbody>{"".join(body)}</tbody></table>'


def timeline():
    days = (END - START).days
    x = lambda d: (d - START).days / days * 100  # noqa: E731
    rows = []
    for label, s, e, kind in BARS:
        bold = ' bold' if kind in ('gate', 'milestone') else ''
        if kind == 'milestone':
            text = f'{s.strftime("%b")} {s.day}'
            where = f'right:calc({100 - x(s)}% + 9px)' if x(s) > 80 else f'left:calc({x(s)}% + 10px)'
            mark = f'<span class="diamond" style="left:{x(s)}%"></span><span class="barlabel" style="{where}">{text}</span>'
        else:
            w = max(x(e + timedelta(days=1)) - x(s), 1.2)
            text = f'{s.strftime("%b")} {s.day} to {e.strftime("%b")} {e.day}'
            # Near the right edge the label goes before the bar, so it is never cut off.
            where = f'right:calc({100 - x(s)}% + 4px)' if x(s) + w > 80 else f'left:calc({x(s) + w}% + 4px)'
            mark = f'<span class="bar {kind}" style="left:{x(s)}%;width:{w}%"></span><span class="barlabel" style="{where}">{text}</span>'
        rows.append(f'<div class="trow"><div class="tlabel{bold}">{escape(label)}</div><div class="ttrack">{mark}</div></div>')
    ticks = ''.join(f'<span class="tick" style="left:{x(t)}%">{t.strftime("%b")} {t.day}</span>' for t in TICKS)
    today = f'<div class="today" style="left:{x(TODAY)}%"><span>today</span></div>'
    return f'''<figure class="timeline">
  <div class="ttitle">Demo ready on 15 December, with agent platforms connected before the kill switch</div>
  <div class="tsub">Build phases by week, 2026. Green: done. Blue: new from the Phase 2 requirements; outlined blue: original phase, extended.</div>
  <div class="tgrid"><div class="trow head"><div class="tlabel"></div><div class="ttrack">{ticks}</div></div>
  {"".join(rows)}<div class="todaywrap"><div class="tlabel"></div><div class="ttrack">{today}</div></div></div>
</figure>
<p class="caption">build timeline · 8 phases, 1 gate, 2 milestones</p>'''


def phase(p):
    widths = ['6%', '44%', '17%', '9%', '16%', '8%'] if p['cols'][-1] == 'Status' else ['6%', '48%', '18%', '10%', '18%']
    if p['title'].startswith('Go/no-go'):
        widths = ['6%', '48%', '14%', '14%', '18%']
    out = f'<h2>{escape(p["title"])} · {escape(p["dates"])} {pill(*p["badge"])}</h2><p>{p["intro"]}</p>'
    out += table(p['cols'], p['rows'], widths)
    if p.get('outro'):
        out += f'<p>{p["outro"]}</p>'
    return out


def build():
    progress = table(['Phase', 'Dates', 'Status', 'Note'],
                     PROGRESS, ['26%', '14%', '18%', '42%'])
    changes = table(['Phase', 'Change', 'Effect'], CHANGES, ['40%', '42%', '18%'])
    reqs = table(['Requirement', 'Change, and why'], REQ_CHANGES, ['26%', '74%'])
    feas = ''.join(f'<li><b>{escape(a)}</b> {escape(b)}</li>' for a, b in FEASIBILITY)
    risks = ''.join(f'<li><b>{escape(a)}</b> {escape(b)}</li>' for a, b in RISKS)
    html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Agent Control Tower — Build Plan</title>
<style>{CSS}</style></head><body>
<h1>Agent Control Tower — Build Plan</h1>
<div class="byline">{chip("Updated " + UPDATED)} · {chip("@Rishabh")} · {chip("First issued Sep 30, 2026")}</div>
<p>Work started {chip("Oct 1, 2026")}. One release covers the original requirements and the Phase 2 requirements (Microsoft Copilot auto-fetch, platform kill switch, reconciliation, alert routing and reporting). The demo is ready on {chip("Dec 15, 2026")}, four weeks later than the original {chip("Nov 17, 2026")}. A credible demo (register, approve, stop an agent inside its platform) exists on {chip("Nov 20, 2026")}.</p>
<h2 class="big">At a glance</h2>
{timeline()}
<p>The platform connection comes before the kill switch, because an agent can only be stopped once Control Tower is connected to where it runs. Alerts follow the kill switch, because most alerts are about suspensions, reactivations and re-blocks.</p>
<h3>What changed from the 30 Sep plan</h3>
{changes}
<p>Tasks marked New come from the Phase 2 requirements; Extended marks original tasks that now also cover them. Requirement numbers (R1.1 and so on) are shown on each.</p>
<h3>Progress so far</h3>
{progress}
<div class="callout"><div class="ctitle">Feasibility check against official documentation (15 Oct)</div><ul>{feas}</ul></div>
<h3>Changes to the Phase 2 requirements</h3>
{reqs}
{"".join(phase(p) for p in PHASES)}
<h2 class="big">Out of scope</h2>
<p>From the Phase 2 requirements: auto-fetch or platform kill switch for ChatGPT, Claude or GitHub Copilot (they stay on the manual form); per-agent token counts unless Microsoft exposes them; classic Copilot Studio chatbots; connecting many client tenants at once. These go on the v2 list.</p>
<h2 class="big">How the date stays tight</h2>
<p>Supabase supplies login, live updates, timers and the API layer ready-made, and AI writes and tests most of the TypeScript. There is no buffer, so these are the risks to watch:</p>
<ul class="risks">{risks}</ul>
<p>The plan assumes working days Monday to Friday and a small team of 2–3 developers using AI; team size was not given.</p>
</body></html>'''
    OUT.write_text(html, encoding='utf-8')
    print(f'wrote {OUT}')


CSS = '''
@page { size: A4; margin: 16mm 14mm 16mm 14mm; }
* { box-sizing: border-box; }
body { font-family: Inter, system-ui, sans-serif; font-size: 10pt; line-height: 1.45; color: #1f2329; margin: 0; }
h1 { font-family: 'Source Serif 4', 'Bitstream Charter', Charter, Georgia, serif; font-weight: 500; font-size: 26pt; margin: 0 0 6px; }
h2 { font-family: 'Source Serif 4', 'Bitstream Charter', Charter, Georgia, serif; font-weight: 500; font-size: 15pt; margin: 22px 0 6px; break-after: avoid; }
h2.big { font-size: 17pt; }
h3 { font-family: 'Source Serif 4', 'Bitstream Charter', Charter, Georgia, serif; font-weight: 600; font-size: 12pt; margin: 16px 0 6px; break-after: avoid; }
p { margin: 6px 0 10px; }
.byline { margin-bottom: 10px; color: #555; }
.chip { background: #efeee9; border-radius: 4px; padding: 1px 6px; font-size: 9pt; white-space: nowrap; }
.pill { display: inline-block; border-radius: 4px; padding: 1px 6px; font-family: Inter, sans-serif; font-size: 8pt; font-weight: 400; vertical-align: middle; white-space: nowrap; }
.pill.done { background: #dff3e4; color: #1d6b35; }
.pill.now { background: #fdf0b8; color: #6b5300; }
.pill.plan { background: #eceef1; color: #4a5260; }
.pill.wait { background: #fde2d2; color: #8a3b0c; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 9pt; table-layout: fixed; }
th { text-align: left; font-weight: 400; color: #444; background: #f6f5f1; }
th, td { border: 1px solid #dedcd5; padding: 5px 7px; vertical-align: top; }
tr { break-inside: avoid; }
.caption { color: #555; font-size: 9pt; margin-top: 2px; }
.callout { background: #f6f5f1; border-left: 3px solid #c9a227; padding: 8px 12px; margin: 10px 0; break-inside: avoid; }
.callout .ctitle { font-weight: 600; margin-bottom: 4px; }
.callout ul, ul.risks { margin: 0; padding-left: 18px; }
.callout li, ul.risks li { margin: 3px 0; }
figure.timeline { background: #f8f7f3; margin: 8px 0 0; padding: 10px 12px 6px; break-inside: avoid; }
.ttitle { font-weight: 600; font-size: 9.5pt; }
.tsub { color: #666; font-size: 8pt; margin-bottom: 6px; }
.trow, .todaywrap { display: flex; align-items: center; height: 17px; }
.todaywrap { height: 12px; }
.trow.head { height: 16px; }
.tlabel { width: 25%; font-size: 8pt; flex: none; }
.tlabel.bold { font-weight: 600; }
.ttrack { position: relative; flex: 1; height: 100%; }
.tick { position: absolute; top: 0; font-size: 7.5pt; color: #666; transform: translateX(-50%); }
.bar { position: absolute; top: 4px; height: 9px; border-radius: 3px; }
.bar.done { background: #cfeed8; border: 1px solid #7fbf91; }
.bar.original { background: #e9e9e6; border: 1px solid #b9b9b3; }
.bar.new { background: #d4e4fb; border: 1px solid #7da7e6; }
.bar.extended { background: #eef2f8; border: 1.5px solid #3567b7; }
.bar.gate { background: #fbe7a6; border: 1px solid #d3a92c; }
.diamond { position: absolute; top: 4px; width: 9px; height: 9px; background: #888; transform: translateX(-50%) rotate(45deg); }
.barlabel { position: absolute; top: 1px; font-size: 7.5pt; white-space: nowrap; color: #333; }
.today { position: absolute; top: -235px; height: 240px; border-left: 1px dashed #d9662b; }
.today span { position: absolute; bottom: 0; left: 3px; font-size: 7pt; color: #d9662b; }
'''

if __name__ == '__main__':
    build()
