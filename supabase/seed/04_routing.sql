-- Demo routing matrix (task 2.3). Adds the two demo rules if they are missing; never duplicates or rewrites them.
-- The £2m payment in the live-approval demo lands with Ravi Menon through the first rule.
insert into public.routing_rules (name, priority, department_id, min_amount, currency, approver_id)
select 'Large payments (£1m and above)', 10, d.id, 1000000, 'GBP', p.id
from public.departments d, public.profiles p
where d.name = 'Payments' and p.email = 'ravi.menon@northbridge.demo'
  and not exists (select 1 from public.routing_rules where name = 'Large payments (£1m and above)');

insert into public.routing_rules (name, priority, data_classification, approver_id)
select 'Agents that touch personal data', 20, 'personal', p.id
from public.profiles p
where p.email = 'omar.farouk@northbridge.demo'
  and not exists (select 1 from public.routing_rules where name = 'Agents that touch personal data');
