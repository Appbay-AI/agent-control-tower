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

Workers & Pages → Create → Pages → Connect to Git → pick this repo.

- Build command: `npm run build`
- Output directory: `dist`
- Environment variables (Production): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` from **act-demo**, `VITE_APP_ENV=demo`
- Environment variables (Preview): the same three from **act-dev**, `VITE_APP_ENV=dev`

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

Every change is a new file in `supabase/migrations/`. Never edit the database by hand in the dashboard; the migration files are the record.
