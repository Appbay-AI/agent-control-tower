-- Demo action request (task 2.4): the Payment Release Assistant asks to release £2m, above its £250k limit, so it
-- waits for a person. The routing rule "Large payments (£1m and above)" puts it in Ravi Menon's queue.
-- Sent through the same function the public API uses, with a key made for the purpose and revoked straight after.
-- Adds it only when the agent has nothing waiting, so running the seed again never duplicates it.
do $$
declare
  a uuid := pg_temp.agent('Payment Release Assistant');
  k text;
begin
  if a is null or exists (select 1 from public.action_requests where agent_id = a and status = 'pending') then return; end if;

  perform pg_temp.act_as('james.whitfield@northbridge.demo');
  k := public.create_agent_api_key(a);
  perform pg_temp.act_as_system();
  perform public.api_request_action(k, jsonb_build_object(
    'idempotency_key', 'demo-hartwell-' || to_char(current_date, 'YYYYMMDD'),
    'action', 'payment.release',
    'description', 'Release £2,000,000 to supplier Hartwell Steel Ltd',
    'reasoning', 'Invoice HS-48817 for the Q4 steel order is due today. It matches purchase order PO-2026-0912 and the '
                 'goods receipt; paying today avoids a 2% late-payment charge (£40,000).',
    'amount', 2000000, 'currency', 'GBP', 'urgency', 'high', 'target_system', 'SWIFT gateway',
    'details', jsonb_build_object('supplier', 'Hartwell Steel Ltd', 'invoice', 'HS-48817', 'purchase_order', 'PO-2026-0912',
                                  'due_date', to_char(current_date, 'YYYY-MM-DD'), 'beneficiary_bank', 'Barclays, London')));

  perform pg_temp.act_as('james.whitfield@northbridge.demo');
  perform public.revoke_api_key(id) from public.agent_api_keys where agent_id = a and revoked_at is null
    and key_hash = public.secret_hash(k);
  perform pg_temp.act_as_system();

  -- Time limit (task 2.9): high urgency means 2 hours, which would expire the demo's main story before a client
  -- meeting. Give it 3 days from the (re)seed instead.
  update public.action_requests set due_at = now() + interval '3 days'
   where agent_id = a and status = 'pending' and due_at is not null;
end $$;
