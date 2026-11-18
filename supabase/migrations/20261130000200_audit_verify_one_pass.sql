-- 18 Nov: checking the audit trail's hash chain in one pass (used by the evidence pack's attestation, task 6.1).
-- The check recomputed every entry's hash in a loop, one entry at a time: 4.4 s for the 19,789 entries on the
-- work-in-progress database, which grows with every test run, and the evidence pack's preview test timed out under
-- load. Now one query recomputes them all, each against the stored hash of the entry before it: 1.0 s for the same
-- entries. The result is the same: nothing when the chain is intact, otherwise the first broken entry with the hash it
-- should have and the hash it has.
create or replace function public.audit_verify_chain()
returns table (broken_seq bigint, expected_hash text, stored_hash text)
language sql stable security definer set search_path = '' as $$
  select x.seq, x.calc, x.hash
    from (select e.seq, e.hash, e.prev_hash,
                 row_number() over (order by e.seq) rn,
                 coalesce(lag(e.hash) over (order by e.seq), 'GENESIS') prev,
                 public.audit_row_digest(e.seq, e.occurred_at, e.actor_id, e.actor_type, e.action, e.entity_type, e.entity_id,
                   e.agent_id, e.summary, e.reason, e.before, e.after, coalesce(lag(e.hash) over (order by e.seq), 'GENESIS')) calc
            from public.audit_events e) x
   where x.seq <> x.rn or x.prev_hash <> x.prev or x.hash <> x.calc
   order by x.seq
   limit 1
$$;
