-- Task 3.1 (resumed): answers so far, saved while the checks run (our API may be cut off part way; what it found is kept).
create function public.microsoft_check_progress(p_token text, p_results jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.microsoft_checks;
begin
  select * into k from public.microsoft_checks where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or k.claimed_at is null or k.finished_at is not null or k.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used token' using errcode = 'invalid_authorization_specification';
  end if;
  if p_results is null or pg_column_size(p_results) > 65536 then
    raise exception 'The results are missing or too large' using errcode = 'check_violation';
  end if;
  update public.microsoft_checks set results = p_results where id = k.id;
end $$;
revoke execute on function public.microsoft_check_progress(text, jsonb) from public, authenticated;
grant execute on function public.microsoft_check_progress(text, jsonb) to anon;
