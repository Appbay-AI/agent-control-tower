# Agent Control Tower

Governance for AI agents: a register of every agent, human approval before high-risk actions, an audited kill switch, incident management and a one-click evidence pack.

## Stack

TypeScript · React + Vite · Tailwind + shadcn/ui · Supabase (Postgres, Auth, Edge Functions, Realtime, pg_cron) · Cloudflare Pages · Resend · GitHub Actions.

## Environments

| Name | Supabase project | Updated by |
|---|---|---|
| `dev` | `act-dev` (`gprwtthwvmmmbslccxpf`) | Automatically, on every merge to `main` |
| `demo` | `act-demo` (`ekowumwkevkzwvkiljvf`) | By hand: Actions → *Database migrations* → Run workflow → `demo` |

## One-time setup

### 1. GitHub environments

Repo **Settings → Environments**: create `dev` and `demo`. In each, add:

| Kind | Name | Where to find it in Supabase |
|---|---|---|
| Variable | `SUPABASE_PROJECT_REF` | Project Settings → General → Project ID |
| Variable | `SUPABASE_URL` | Project Settings → API → Project URL |
| Variable | `SUPABASE_PUBLISHABLE_KEY` | Project Settings → API Keys → Publishable key |
| Secret | `SUPABASE_DB_PASSWORD` | The password you set when creating the project |

Repo **Settings → Secrets and variables → Actions**: add one repository secret,
`SUPABASE_ACCESS_TOKEN` (Supabase → Account → Access Tokens → Generate).

Secret keys and passwords go only into GitHub secrets, never into code or chat.

### 2. Cloudflare Pages

GitHub builds the app and uploads it to Cloudflare (`.github/workflows/deploy.yml`), using the
Supabase variables of the matching GitHub environment. Nothing is configured inside Cloudflare
except the project itself.

| Branch | Link | Database |
|---|---|---|
| `demo` | https://agent-control-tower-56p.pages.dev (production, shown to clients) | act-demo |
| `main` | https://main.agent-control-tower-56p.pages.dev (preview, work in progress) | act-dev |

Repository secrets needed: `CLOUDFLARE_API_TOKEN` (Cloudflare → My Profile → API Tokens →
Create token, permission *Account · Cloudflare Pages · Edit*) and `CLOUDFLARE_ACCOUNT_ID`
(Cloudflare → Workers & Pages, right-hand side). The Pages project's production branch must be `demo`.
If the project is not named `agent-control-tower`, set a repository variable `CLOUDFLARE_PROJECT_NAME`.

To update the client demo: merge `main` into `demo`, then run *Database migrations* for `demo` if the
release includes database changes.

## Commands

```bash
npm install
npm run dev         # local dev server (optional; needs .env.local, see .env.example)
npm test            # unit tests
npm run typecheck
npm run lint
npm run build
```

## Database changes

Every change is a new file in `supabase/migrations/`. Each new table needs both an RLS policy and an explicit `GRANT` to `anon`/`authenticated`; new Supabase projects grant nothing by default. Never edit the database by hand in the dashboard; the migration files are the record.

Supabase grants `execute` on new functions to everyone by default, so every migration that adds a function ends with an explicit `revoke ... from public, anon, authenticated` and grants only what is needed.

`npm run test:db` loads every migration into an in-memory Postgres (PGlite) with stand-ins for Supabase's `auth` schema and API roles, then tests the business rules, security policies and audit log.
