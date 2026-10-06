-- The /api/v1 endpoints run on Cloudflare and call these two functions with the public (publishable) key.
-- Each function authenticates the caller itself: a valid, unrevoked integration key or agent key is required,
-- compared by SHA-256 hash. Keys carry 244 random bits, so guessing is not feasible.
grant execute on function public.api_register_agent(text, jsonb), public.api_agent_status(text) to anon;
