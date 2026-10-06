-- Phase 1, task 1.1: registry data model.
-- Departments, people and roles, agents with every registry field from the requirements (§6.1),
-- registration approvals, reviews, alerts and API keys.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'approver', 'owner', 'executive', 'auditor');
create type public.agent_status as enum ('proposed', 'approved', 'live', 'suspended', 'retired');
create type public.risk_tier as enum ('low', 'medium', 'high', 'critical');
create type public.agent_origin as enum ('internal', 'vendor');
create type public.agent_framework as enum ('langchain', 'appian', 'vendor_embedded', 'other');
create type public.data_classification as enum ('public', 'internal', 'confidential', 'restricted', 'personal');
create type public.registration_status as enum ('pending', 'approved', 'rejected', 'sent_back');
create type public.registration_decision as enum ('approve', 'reject', 'send_back');
create type public.review_outcome as enum ('no_change', 'changes_required', 'retire');
create type public.alert_kind as enum ('review_overdue', 'owner_missing');

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) > 0),
  cost_centre text,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text,
  job_title text,
  department_id uuid references public.departments (id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.app_role not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Which departments an approver may approve for. Approvers see only these agents.
create table public.approver_scopes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  primary key (user_id, department_id)
);

-- Every new login gets a profile.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Agents (§6.1)
-- ---------------------------------------------------------------------------
create sequence public.agent_code_seq;

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  agent_code text not null unique default ('AGT-' || lpad(nextval('public.agent_code_seq')::text, 4, '0')),

  -- Identity
  name text not null check (length(trim(name)) > 0),
  description text,
  version text,
  origin public.agent_origin not null default 'internal',
  vendor_name text,
  framework public.agent_framework not null default 'other',

  -- Ownership
  business_owner_id uuid references public.profiles (id) on delete set null,
  technical_owner_id uuid references public.profiles (id) on delete set null,
  department_id uuid references public.departments (id) on delete set null,
  cost_centre text,

  -- Purpose
  purpose_statement text not null default '',
  in_scope_actions text[] not null default '{}',
  out_of_scope_actions text[] not null default '{}',

  -- Access
  systems_accessed text[] not null default '{}',
  data_classifications public.data_classification[] not null default '{}',
  credential_type text,
  credential_owner text,

  -- Autonomy (§6.2)
  autonomy_level smallint not null default 1 check (autonomy_level between 1 and 4),
  value_threshold numeric(16, 2) check (value_threshold is null or value_threshold >= 0),
  threshold_currency char(3) not null default 'GBP',
  volume_threshold integer check (volume_threshold is null or volume_threshold >= 0),

  -- Risk
  risk_tier public.risk_tier not null default 'medium',
  regulatory_flags text[] not null default '{}',

  -- Lifecycle (changed only through the workflow functions)
  status public.agent_status not null default 'proposed',
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  last_review_date date,
  next_review_date date,

  registration_source text not null default 'manual' check (registration_source in ('manual', 'api', 'discovered')),
  control_endpoint text,

  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Level 3 acts alone only below its limits, so it must have at least one.
  constraint level3_needs_threshold check (autonomy_level <> 3 or value_threshold is not null or volume_threshold is not null),
  constraint vendor_needs_name check (origin <> 'vendor' or vendor_name is not null)
);

create index agents_department_idx on public.agents (department_id);
create index agents_business_owner_idx on public.agents (business_owner_id);
create index agents_technical_owner_idx on public.agents (technical_owner_id);
create index agents_status_idx on public.agents (status);

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Registration approval (§6.1: registering an agent is an approval workflow)
-- ---------------------------------------------------------------------------
create table public.agent_registrations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz not null default now(),
  status public.registration_status not null default 'pending',
  required_approvals smallint not null default 1 check (required_approvals between 1 and 2),
  decided_at timestamptz,
  decision_reason text
);

-- At most one open registration per agent.
create unique index agent_registrations_one_pending on public.agent_registrations (agent_id) where status = 'pending';
create index agent_registrations_agent_idx on public.agent_registrations (agent_id);

create table public.registration_decisions (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.agent_registrations (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  approver_id uuid not null references public.profiles (id),
  decision public.registration_decision not null,
  reason text,
  decided_at timestamptz not null default now(),
  unique (registration_id, approver_id),
  constraint reason_required check (decision = 'approve' or length(trim(coalesce(reason, ''))) > 0)
);

-- ---------------------------------------------------------------------------
-- Reviews and alerts (§6.1: review every 6 months, overdue raises an alert)
-- ---------------------------------------------------------------------------
create table public.agent_reviews (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  reviewer_id uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz not null default now(),
  outcome public.review_outcome not null,
  notes text,
  next_review_date date
);
create index agent_reviews_agent_idx on public.agent_reviews (agent_id);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  kind public.alert_kind not null,
  agent_id uuid not null references public.agents (id) on delete cascade,
  message text not null,
  raised_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index alerts_one_open on public.alerts (kind, agent_id) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- API keys (§7). Only a SHA-256 hash is stored; the key itself is shown once.
-- ---------------------------------------------------------------------------
create table public.integration_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

create table public.agent_api_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  key_prefix text not null,
  key_hash text not null unique,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index agent_api_keys_agent_idx on public.agent_api_keys (agent_id);
