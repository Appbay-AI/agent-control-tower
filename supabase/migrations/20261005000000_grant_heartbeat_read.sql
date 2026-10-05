-- New Supabase projects do not grant API roles access to tables automatically.
-- Every table the app reads needs an explicit GRANT on top of its RLS policy:
-- the GRANT opens the door to the role, the policy decides which rows it sees.

grant select on public.system_heartbeat to anon, authenticated;
