-- Northbridge Bank demo data (fictional). Run after 01_users.sql by the "Seed demo data" workflow.
-- Every lifecycle step goes through the real workflow functions, signed in as the right persona,
-- so the audit trail reads like a real history. Dates are then moved back to look lived-in.
-- Idempotent: does nothing if the demo agents already exist.

-- Helpers (pg_temp.act_as, approve, backdate, ...) are in 00_helpers.sql.

do $$
begin
  if exists (select 1 from public.agents where name = 'Payment Release Assistant') then
    raise notice 'Demo bank already seeded; nothing to do';
    return;
  end if;

  -- -------------------------------------------------------------------------
  -- Organisation
  -- -------------------------------------------------------------------------
  insert into public.departments (name, cost_centre) values
    ('Payments', 'CC-410'), ('Treasury', 'CC-420'), ('Retail Lending', 'CC-220'), ('Commercial Lending', 'CC-230'),
    ('Operations', 'CC-105'), ('Customer Service', 'CC-310'), ('Compliance', 'CC-150'), ('Technology', 'CC-900')
  on conflict (name) do nothing;

  update public.profiles p set job_title = t.title, department_id = pg_temp.dept(t.dept)
  from (values
    ('admin@northbridge.demo', 'Control Tower administrator', 'Technology'),
    ('priya.sharma@northbridge.demo', 'Chief Risk Officer', null),
    ('ravi.menon@northbridge.demo', 'Head of Operational Risk', null),
    ('daniel.okafor@northbridge.demo', 'Payments Risk Lead', 'Payments'),
    ('sara.haddad@northbridge.demo', 'Head of Credit Risk', 'Retail Lending'),
    ('omar.farouk@northbridge.demo', 'Operations Risk Manager', 'Operations'),
    ('james.whitfield@northbridge.demo', 'Head of Payments Product', 'Payments'),
    ('aisha.rahman@northbridge.demo', 'Lending Product Lead', 'Retail Lending'),
    ('tom.becker@northbridge.demo', 'Automation Engineering Lead', 'Technology'),
    ('lucy.grant@northbridge.demo', 'Customer Service Director', 'Customer Service'),
    ('mei.lin@northbridge.demo', 'Internal Audit Manager', null)
  ) as t(email, title, dept)
  where p.email = t.email;

  insert into public.user_roles (user_id, role)
  select pg_temp.uid(e), r::public.app_role from (values
    ('admin@northbridge.demo', 'admin'),
    ('priya.sharma@northbridge.demo', 'executive'),
    ('ravi.menon@northbridge.demo', 'approver'),
    ('daniel.okafor@northbridge.demo', 'approver'),
    ('sara.haddad@northbridge.demo', 'approver'),
    ('omar.farouk@northbridge.demo', 'approver'),
    ('james.whitfield@northbridge.demo', 'owner'),
    ('aisha.rahman@northbridge.demo', 'owner'),
    ('tom.becker@northbridge.demo', 'owner'),
    ('lucy.grant@northbridge.demo', 'owner'),
    ('mei.lin@northbridge.demo', 'auditor')
  ) as t(e, r)
  on conflict do nothing;

  -- Ravi (second line of defence) approves for every department, so four-eyes always has a second approver.
  insert into public.approver_scopes (user_id, department_id)
  select pg_temp.uid('ravi.menon@northbridge.demo'), id from public.departments
  union all
  select pg_temp.uid(e), pg_temp.dept(d) from (values
    ('daniel.okafor@northbridge.demo', 'Payments'), ('daniel.okafor@northbridge.demo', 'Treasury'),
    ('sara.haddad@northbridge.demo', 'Retail Lending'), ('sara.haddad@northbridge.demo', 'Commercial Lending'),
    ('omar.farouk@northbridge.demo', 'Operations'), ('omar.farouk@northbridge.demo', 'Customer Service'),
    ('omar.farouk@northbridge.demo', 'Compliance'), ('omar.farouk@northbridge.demo', 'Technology')
  ) as t(e, d)
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Agents. Each block is its own transaction so a persona's identity never leaks into the next.
-- ---------------------------------------------------------------------------
do $$
declare
  james uuid := pg_temp.uid('james.whitfield@northbridge.demo');
  aisha uuid := pg_temp.uid('aisha.rahman@northbridge.demo');
  tom   uuid := pg_temp.uid('tom.becker@northbridge.demo');
  lucy  uuid := pg_temp.uid('lucy.grant@northbridge.demo');
begin
  if exists (select 1 from public.agents where name = 'Payment Release Assistant') then return; end if;

  -- Rows are inserted as their owners, so "Registered" in the audit trail names the right person.
  perform pg_temp.act_as('james.whitfield@northbridge.demo');
  insert into public.agents (name, description, framework, business_owner_id, technical_owner_id, department_id,
    purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed, data_classifications,
    credential_type, credential_owner, autonomy_level, value_threshold, volume_threshold, risk_tier, regulatory_flags,
    control_endpoint, version, created_by)
  values
    ('Payment Release Assistant', 'Prepares outbound supplier payments and releases those under its limit.', 'langchain',
      james, tom, pg_temp.dept('Payments'),
      'Prepare and release outbound supplier payments that match an approved invoice and purchase order.',
      '{"Draft payment instruction","Release payment under limit","Request approval above limit"}',
      '{"Change beneficiary bank details","Pay a supplier not in the vendor master"}',
      '{"SAP S/4HANA","SWIFT gateway"}', '{confidential,personal}', 'Service account', 'Treasury IT',
      3, 250000, 400, 'critical', '{"EU AI Act","DORA"}', 'https://agents.northbridge.demo/payment-release/control', '2.3', james),
    ('Invoice Matcher', 'Matches supplier invoices to purchase orders.', 'langchain', james, tom, pg_temp.dept('Payments'),
      'Match supplier invoices to purchase orders and goods receipts, and flag mismatches for a person to resolve.',
      '{"Read invoices","Mark invoice matched","Raise mismatch task"}', '{"Approve payment"}',
      '{"SAP S/4HANA","Coupa"}', '{confidential}', 'Service account', 'Finance IT', 3, 5000, 2000, 'medium', '{"SOX"}', null, '1.8', james),
    ('Sanctions Pre-screener', 'Checks counterparties before payments are released.', 'appian', james, tom, pg_temp.dept('Payments'),
      'Pre-screen payment counterparties against sanctions lists and recommend hold or release to a payments officer.',
      '{"Screen counterparty","Recommend hold"}', '{"Release payment","Clear a sanctions hit"}',
      '{"World-Check","SWIFT gateway"}', '{restricted,personal}', 'API key', 'Financial Crime IT', 1, null, null, 'high', '{"EU AI Act"}', null, '1.2', james),
    ('Supplier Onboarding Bot', 'Collects supplier bank details and documents for new vendors.', 'langchain', james, tom, pg_temp.dept('Payments'),
      'Collect and validate new supplier documents and bank details, then hand the case to procurement for approval.',
      '{"Request documents","Validate IBAN","Create onboarding case"}', '{"Activate supplier","Change existing supplier"}',
      '{"Coupa","Supplier portal"}', '{confidential,personal}', 'OAuth client', 'Procurement IT', 2, null, null, 'high', '{"GDPR"}', null, '0.9', james),
    ('FX Payment Router', 'Chooses the settlement route and executes FX conversions for cross-border payments.', 'langchain',
      james, tom, pg_temp.dept('Treasury'),
      'Choose the cheapest compliant route for cross-border payments and execute the FX conversion within its limit.',
      '{"Quote FX rate","Book FX deal under limit","Route payment"}', '{"Speculative FX trades","Change counterparty limits"}',
      '{"Murex","SWIFT gateway"}', '{confidential}', 'Service account', 'Treasury IT', 3, 1000000, 150, 'critical', '{"DORA","EU AI Act"}',
      'https://agents.northbridge.demo/fx-router/control', '1.0', james),
    ('Cash Forecast Agent', 'Daily liquidity forecast for the treasury desk.', 'other', james, tom, pg_temp.dept('Treasury'),
      'Produce the daily 13-week cash forecast for the treasury desk. Recommends only; never moves money.',
      '{"Read balances","Publish forecast"}', '{"Move funds"}', '{"Kyriba","SAP S/4HANA"}', '{confidential}',
      'Read-only service account', 'Treasury IT', 1, null, null, 'medium', '{}', null, '3.1', james);

  perform pg_temp.act_as('aisha.rahman@northbridge.demo');
  insert into public.agents (name, description, framework, business_owner_id, technical_owner_id, department_id,
    purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed, data_classifications,
    credential_type, credential_owner, autonomy_level, value_threshold, volume_threshold, risk_tier, regulatory_flags, version, created_by)
  values
    ('Credit Memo Drafter', 'Drafts credit memos for small business loans.', 'langchain', aisha, tom, pg_temp.dept('Retail Lending'),
      'Draft credit memos for small business loan applications for an underwriter to review and sign.',
      '{"Read application","Draft memo"}', '{"Approve loan","Change credit limit"}', '{"nCino","Experian"}', '{confidential,personal}',
      'Service account', 'Lending IT', 2, null, null, 'high', '{"EU AI Act"}', '1.4', aisha),
    ('Affordability Checker', 'Runs affordability checks on personal loan applications.', 'langchain', aisha, tom, pg_temp.dept('Retail Lending'),
      'Run affordability checks on personal loan applications and decline those clearly outside policy.',
      '{"Read bank statements","Calculate affordability","Decline outside policy"}', '{"Approve a loan"}',
      '{"Open Banking hub","nCino"}', '{personal,confidential}', 'OAuth client', 'Lending IT', 3, null, 500, 'high', '{"EU AI Act","GDPR"}', '2.0', aisha),
    ('Collections Outreach Agent', 'Contacts customers in early arrears.', 'other', aisha, tom, pg_temp.dept('Retail Lending'),
      'Contact customers in early arrears with approved messages and offer standard payment plans.',
      '{"Send approved message","Offer standard payment plan"}', '{"Waive fees","Threaten legal action"}',
      '{"Collections CRM","Twilio"}', '{personal}', 'API key', 'Collections IT', 3, null, 200, 'high', '{"GDPR"}', '1.1', aisha),
    ('Loan Document Extractor', 'Extracts data from payslips and statements.', 'appian', aisha, tom, pg_temp.dept('Retail Lending'),
      'Extract income and identity fields from uploaded loan documents for a case handler to confirm.',
      '{"Read documents","Fill extraction form"}', '{"Decide on application"}', '{"Appian","Document store"}', '{personal}',
      'Service account', 'Lending IT', 1, null, null, 'medium', '{"GDPR"}', '1.0', aisha),
    ('Mortgage Pre-qualifier', 'Gives indicative mortgage eligibility.', 'langchain', aisha, null, pg_temp.dept('Retail Lending'),
      'Give customers an indicative mortgage amount based on what they tell us.',
      '{"Ask eligibility questions","Show indicative amount"}', '{"Make an offer"}', '{"Website"}', '{personal}',
      null, null, 2, null, null, 'high', '{"EU AI Act"}', '0.3', aisha),
    ('Covenant Monitor', 'Tracks loan covenants for commercial clients.', 'other', aisha, tom, pg_temp.dept('Commercial Lending'),
      'Monitor financial covenants on commercial loans and alert relationship managers before a breach.',
      '{"Read financials","Raise covenant alert"}', '{"Change loan terms"}', '{"nCino","Moody''s"}', '{confidential}',
      'Read-only service account', 'Lending IT', 1, null, null, 'medium', '{}', '1.0', aisha);

  perform pg_temp.act_as('tom.becker@northbridge.demo');
  insert into public.agents (name, description, framework, business_owner_id, technical_owner_id, department_id,
    purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed, data_classifications,
    credential_type, credential_owner, autonomy_level, value_threshold, volume_threshold, risk_tier, regulatory_flags, version, created_by)
  values
    ('Ops Ticket Triage', 'Routes internal IT and operations tickets.', 'langchain', tom, tom, pg_temp.dept('Operations'),
      'Classify and route internal operations tickets to the right resolver group.',
      '{"Classify ticket","Assign resolver group"}', '{"Close ticket","Grant access"}', '{"ServiceNow"}', '{internal}',
      'OAuth client', 'Technology', 4, null, null, 'low', '{}', '2.2', tom),
    ('Reconciliation Exceptions Agent', 'Clears low-value reconciliation breaks.', 'appian', tom, tom, pg_temp.dept('Operations'),
      'Investigate nostro reconciliation breaks and clear those under the limit with a documented match.',
      '{"Investigate break","Clear break under limit"}', '{"Write off balances"}', '{"SmartStream TLM","SAP S/4HANA"}', '{confidential}',
      'Service account', 'Operations IT', 3, 10000, 300, 'medium', '{"SOX"}', '1.5', tom),
    ('Branch Rota Planner', 'Plans branch staff rotas.', 'other', tom, tom, pg_temp.dept('Operations'),
      'Propose weekly branch staff rotas for branch managers to approve.',
      '{"Read availability","Propose rota"}', '{"Publish rota"}', '{"Workday"}', '{personal}', 'OAuth client', 'HR IT',
      2, null, null, 'low', '{"GDPR"}', '1.0', tom),
    ('Regulatory Change Summariser', 'Summarises new regulation for the compliance team.', 'langchain', tom, tom, pg_temp.dept('Compliance'),
      'Summarise new regulatory publications and route them to the policy owner.',
      '{"Read publications","Draft summary"}', '{"Change policy"}', '{"SharePoint"}', '{public,internal}', 'OAuth client', 'Technology',
      1, null, null, 'low', '{}', '1.3', tom),
    ('KYC Refresh Agent', 'Chases customers for periodic KYC refresh.', 'appian', tom, tom, pg_temp.dept('Compliance'),
      'Request updated KYC documents from customers due for periodic review and prepare the file for an analyst.',
      '{"Request documents","Prepare KYC file"}', '{"Approve KYC","Exit a customer"}', '{"Fenergo","Appian"}', '{personal,restricted}',
      'Service account', 'Financial Crime IT', 2, null, null, 'high', '{"GDPR"}', '1.6', tom),
    ('Access Review Assistant', 'Prepared quarterly access reviews. Replaced by the IAM platform.', 'other', tom, tom, pg_temp.dept('Technology'),
      'Prepare quarterly user access review packs for system owners.',
      '{"Read entitlements","Build review pack"}', '{"Remove access"}', '{"SailPoint"}', '{internal}', 'Service account', 'Technology',
      1, null, null, 'medium', '{"SOX"}', '0.8', tom);

  perform pg_temp.act_as('lucy.grant@northbridge.demo');
  insert into public.agents (name, description, framework, business_owner_id, technical_owner_id, department_id,
    purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed, data_classifications,
    credential_type, credential_owner, autonomy_level, value_threshold, volume_threshold, risk_tier, regulatory_flags, version, created_by)
  values
    ('Complaint Classifier', 'Classifies incoming customer complaints.', 'langchain', lucy, tom, pg_temp.dept('Customer Service'),
      'Classify incoming complaints by product and severity and flag likely regulatory complaints.',
      '{"Read complaint","Set category and severity"}', '{"Reply to customer","Close complaint"}', '{"Salesforce"}', '{personal}',
      'OAuth client', 'CX IT', 1, null, null, 'medium', '{"GDPR"}', '1.2', lucy),
    ('Chat Refund Agent', 'Issues small goodwill refunds in web chat.', 'langchain', lucy, tom, pg_temp.dept('Customer Service'),
      'Issue goodwill refunds of fees in web chat when the customer meets the published criteria.',
      '{"Check refund criteria","Refund fee under limit"}', '{"Refund interest","Refund above limit"}',
      '{"Core banking","Web chat"}', '{personal,confidential}', 'Service account', 'CX IT', 3, 200, 300, 'high', '{"EU AI Act"}', '1.0', lucy);

  -- The shadow agent: a vendor feature switched on in Operations that nobody registered. No owner, no purpose.
  perform pg_temp.act_as('omar.farouk@northbridge.demo');
  insert into public.agents (name, description, origin, vendor_name, framework, department_id, purpose_statement,
    systems_accessed, data_classifications, autonomy_level, risk_tier, created_by)
  values ('Copilot for Ops Tickets', 'Vendor AI assistant found switched on in the ticketing tool during an access review. Not registered by anyone.',
    'vendor', 'Ticketing platform vendor', 'vendor_embedded', pg_temp.dept('Operations'), '',
    '{"ServiceNow"}', '{internal,personal}', 4, 'medium', pg_temp.uid('omar.farouk@northbridge.demo'));
end $$;

update public.agents set registration_source = 'discovered' where name = 'Copilot for Ops Tickets';

-- ---------------------------------------------------------------------------
-- Lifecycles, each through the real workflow functions
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from public.agents where status <> 'proposed') then return; end if;

  -- Critical: four-eyes, two approvers.
  perform pg_temp.approve('Payment Release Assistant', 'james.whitfield@northbridge.demo',
    array['daniel.okafor@northbridge.demo', 'ravi.menon@northbridge.demo'], true);
  perform pg_temp.approve('Invoice Matcher', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Sanctions Pre-screener', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Cash Forecast Agent', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Credit Memo Drafter', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Affordability Checker', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Collections Outreach Agent', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Loan Document Extractor', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Covenant Monitor', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Ops Ticket Triage', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Reconciliation Exceptions Agent', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Branch Rota Planner', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Regulatory Change Summariser', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('KYC Refresh Agent', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Access Review Assistant', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Complaint Classifier', 'lucy.grant@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Chat Refund Agent', 'lucy.grant@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
end $$;

do $$
declare reg uuid;
begin
  if exists (select 1 from public.agent_registrations where status = 'pending') then return; end if;

  -- Waiting for approval: Daniel's queue.
  perform pg_temp.act_as('james.whitfield@northbridge.demo');
  perform public.submit_agent_for_approval(pg_temp.agent('Supplier Onboarding Bot'));

  -- Critical, four-eyes: Daniel has approved; it waits for Ravi.
  reg := public.submit_agent_for_approval(pg_temp.agent('FX Payment Router'));
  perform pg_temp.act_as('daniel.okafor@northbridge.demo');
  perform public.decide_registration(reg, 'approve', null);

  -- Sent back by Sara with a reason; Aisha has not resubmitted yet.
  perform pg_temp.act_as('aisha.rahman@northbridge.demo');
  reg := public.submit_agent_for_approval(pg_temp.agent('Mortgage Pre-qualifier'));
  perform pg_temp.act_as('sara.haddad@northbridge.demo');
  perform public.decide_registration(reg, 'send_back',
    'Name a technical owner, and say how indicative amounts are kept separate from formal offers (Consumer Duty).');

  -- Retired after the IAM platform replaced it.
  perform pg_temp.act_as('tom.becker@northbridge.demo');
  perform public.retire_agent(pg_temp.agent('Access Review Assistant'), 'Replaced by SailPoint access certifications in Q2.');
end $$;

-- Six live agents lost their owner when people left or moved team. An admin cleared the owner field.
do $$ begin
  if exists (select 1 from public.agents where status = 'live' and business_owner_id is null) then return; end if;
  perform pg_temp.act_as('admin@northbridge.demo');
  perform set_config('act.reason', 'Owner left the bank; HR leaver process', true);
  update public.agents set business_owner_id = null
  where name in ('Credit Memo Drafter', 'Covenant Monitor', 'Branch Rota Planner', 'Regulatory Change Summariser',
                 'KYC Refresh Agent', 'Complaint Classifier');
  perform set_config('act.reason', '', true);
end $$;

-- History: when each agent was registered and approved, and when its review is due (four are overdue).
do $$ begin
  if (select created_at from public.agents where name = 'Payment Release Assistant') < now() - interval '30 days' then
    return;
  end if;
  perform pg_temp.backdate('Payment Release Assistant', 420, 200, current_date - 20);
  perform pg_temp.backdate('Invoice Matcher', 380, 150, current_date + 33);
  perform pg_temp.backdate('Sanctions Pre-screener', 300, 90, current_date + 92);
  perform pg_temp.backdate('Cash Forecast Agent', 500, 60, current_date + 122);
  perform pg_temp.backdate('Credit Memo Drafter', 350, 120, current_date + 62);
  perform pg_temp.backdate('Affordability Checker', 410, 230, current_date - 45);
  perform pg_temp.backdate('Collections Outreach Agent', 390, 210, current_date - 27);
  perform pg_temp.backdate('Loan Document Extractor', 260, 100, current_date + 82);
  perform pg_temp.backdate('Covenant Monitor', 330, 140, current_date + 41);
  perform pg_temp.backdate('Ops Ticket Triage', 450, 80, current_date + 102);
  perform pg_temp.backdate('Reconciliation Exceptions Agent', 470, 250, current_date - 68);
  perform pg_temp.backdate('Branch Rota Planner', 280, 110, current_date + 72);
  perform pg_temp.backdate('Regulatory Change Summariser', 240, 70, current_date + 112);
  perform pg_temp.backdate('KYC Refresh Agent', 360, 160, current_date + 22);
  perform pg_temp.backdate('Complaint Classifier', 310, 130, current_date + 52);
  perform pg_temp.backdate('Chat Refund Agent', 200, 45, current_date + 137);
  perform pg_temp.backdate('Access Review Assistant', 600, 400, null);
end $$;

-- Raise the alerts the daily job would raise.
do $$ begin
  perform pg_temp.act_as_system();
  perform public.refresh_alerts();
end $$;

select status, count(*) from public.agents group by status order by status;
