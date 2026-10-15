-- Northbridge Bank, part 2: brings the registry to 40 agents and adds a year of review history.
-- Run after 00_helpers.sql and 02_demo_bank.sql in the same psql session. Idempotent.
-- All new agents have owners and are within their review dates, so the demo story stays exactly:
-- 6 live agents without an owner, 4 overdue reviews, 1 shadow vendor agent.

do $$
declare
  j text := 'james.whitfield@northbridge.demo';
  a text := 'aisha.rahman@northbridge.demo';
  t text := 'tom.becker@northbridge.demo';
  l text := 'lucy.grant@northbridge.demo';
begin
  if exists (select 1 from public.agents where name = 'Direct Debit Mandate Checker') then
    raise notice 'Part 2 already seeded; nothing to do';
    return;
  end if;

  -- Payments and Treasury (James)
  perform pg_temp.new_agent(j, t, 'Payments', 'Direct Debit Mandate Checker', 'Validates new direct debit mandates.', 'langchain',
    'Check new direct debit mandates against account and customer data, and reject those that fail the scheme rules.',
    '{"Validate mandate","Reject invalid mandate"}', '{"Amend a mandate","Collect a payment"}', '{"Bacs gateway","Core banking"}',
    '{personal}', 'Service account', 'Payments IT', 3::smallint, null, 1000, 'medium', '{}', '1.4');
  perform pg_temp.new_agent(j, t, 'Payments', 'Payment Repair Bot', 'Repairs payments rejected for formatting errors.', 'langchain',
    'Repair outbound payments rejected for formatting errors and resubmit those under the limit.',
    '{"Correct field format","Resubmit under limit"}', '{"Change amount","Change beneficiary"}', '{"SWIFT gateway","Payment hub"}',
    '{confidential}', 'Service account', 'Payments IT', 3::smallint, 50000, 300, 'high', '{"DORA"}', '2.0');
  perform pg_temp.new_agent(j, t, 'Treasury', 'Liquidity Buffer Monitor', 'Watches intraday liquidity against the buffer.', 'other',
    'Monitor intraday liquidity against the regulatory buffer and alert the treasury desk early.',
    '{"Read balances","Raise liquidity alert"}', '{"Move funds"}', '{"Kyriba"}', '{confidential}',
    'Read-only service account', 'Treasury IT', 1::smallint, null, null, 'medium', '{"DORA"}', '1.1');
  perform pg_temp.new_agent(j, t, 'Treasury', 'Hedge Accounting Assistant', 'Prepares hedge effectiveness tests.', 'appian',
    'Prepare quarterly hedge effectiveness tests for the treasury accountant to approve.',
    '{"Run effectiveness test","Draft journal"}', '{"Post journal"}', '{"Murex","SAP S/4HANA"}', '{confidential}',
    'Service account', 'Finance IT', 2::smallint, null, null, 'high', '{"SOX"}', '1.0');

  -- Lending (Aisha)
  perform pg_temp.new_agent(a, t, 'Retail Lending', 'Credit Card Limit Advisor', 'Recommends credit limit changes.', 'langchain',
    'Recommend credit card limit increases or decreases for an underwriter to approve.',
    '{"Analyse account","Recommend limit change"}', '{"Change a limit"}', '{"Card platform","Experian"}', '{personal,confidential}',
    'Service account', 'Cards IT', 2::smallint, null, null, 'high', '{"EU AI Act","GDPR"}', '1.3');
  perform pg_temp.new_agent(a, t, 'Retail Lending', 'Arrears Hardship Classifier', 'Spots customers who may be in financial hardship.', 'langchain',
    'Flag customers in arrears who show signs of financial hardship so a specialist contacts them.',
    '{"Read account notes","Flag possible hardship"}', '{"Contact customer","Change repayment terms"}', '{"Collections CRM"}',
    '{personal}', 'OAuth client', 'Collections IT', 1::smallint, null, null, 'high', '{"GDPR"}', '1.0');
  perform pg_temp.new_agent(a, t, 'Commercial Lending', 'Trade Finance Document Checker', 'Checks letters of credit documents.', 'langchain',
    'Check trade documents against letter of credit terms and pass compliant sets straight through.',
    '{"Compare documents to LC terms","Pass compliant set"}', '{"Waive a discrepancy","Release funds"}', '{"Trade finance platform"}',
    '{confidential}', 'Service account', 'Trade IT', 3::smallint, null, 100, 'high', '{"EU AI Act"}', '1.2');
  perform pg_temp.new_agent(a, t, 'Commercial Lending', 'Commercial Credit Spreader', 'Spreads client financial statements.', 'appian',
    'Spread commercial clients'' financial statements into the credit model for an analyst to check.',
    '{"Read statements","Populate credit model"}', '{"Set a rating"}', '{"nCino","Moody''s"}', '{confidential}',
    'Service account', 'Lending IT', 2::smallint, null, null, 'medium', '{}', '2.1');

  -- Operations, Compliance and Technology (Tom)
  perform pg_temp.new_agent(t, t, 'Operations', 'Statement Generation Agent', 'Assembles monthly customer statements.', 'other',
    'Assemble and quality-check monthly customer statements before the print run.',
    '{"Assemble statement","Quality check"}', '{"Change balances"}', '{"Core banking","Print hub"}', '{personal}',
    'Service account', 'Operations IT', 4::smallint, null, null, 'low', '{}', '3.0');
  perform pg_temp.new_agent(t, t, 'Operations', 'Mail Room Router', 'Routes scanned post to the right team.', 'langchain',
    'Classify scanned incoming post and route it to the right operations queue.',
    '{"Classify document","Route to queue"}', '{"Act on the request"}', '{"Document store","Appian"}', '{personal}',
    'Service account', 'Operations IT', 4::smallint, null, null, 'low', '{"GDPR"}', '1.6');
  perform pg_temp.new_agent(t, t, 'Operations', 'Cheque Exception Handler', 'Resolves cheque clearing exceptions.', 'appian',
    'Resolve cheque clearing exceptions under the limit and send the rest to a clerk.',
    '{"Investigate exception","Resolve under limit"}', '{"Return a cheque unpaid"}', '{"Image clearing system"}', '{confidential}',
    'Service account', 'Operations IT', 3::smallint, 2500, 200, 'medium', '{}', '1.0');
  perform pg_temp.new_agent(t, t, 'Compliance', 'Transaction Monitoring Triage', 'Prioritises transaction monitoring alerts.', 'langchain',
    'Score transaction monitoring alerts and recommend which to investigate first. Never closes an alert.',
    '{"Score alert","Recommend priority"}', '{"Close alert","File a suspicious activity report"}', '{"Actimize"}',
    '{restricted,personal}', 'Service account', 'Financial Crime IT', 1::smallint, null, null, 'high', '{"EU AI Act"}', '1.4');
  perform pg_temp.new_agent(t, t, 'Compliance', 'Policy Q&A Assistant', 'Answers staff questions about bank policy.', 'langchain',
    'Answer staff questions about internal policy, citing the policy document.',
    '{"Search policies","Answer with citation"}', '{"Change policy"}', '{"SharePoint"}', '{internal}',
    'OAuth client', 'Technology', 1::smallint, null, null, 'low', '{}', '2.0');
  perform pg_temp.new_agent(t, t, 'Technology', 'Code Review Assistant', 'Reviews code changes before human review.', 'langchain',
    'Review code changes for defects and security issues before a developer approves them.',
    '{"Comment on pull request"}', '{"Merge code","Deploy"}', '{"GitHub Enterprise"}', '{internal}',
    'GitHub app', 'Technology', 2::smallint, null, null, 'medium', '{"DORA"}', '1.0');
  perform pg_temp.new_agent(t, t, 'Technology', 'Incident Summariser', 'Summarises IT incidents for the morning call.', 'other',
    'Summarise overnight IT incidents for the morning service call.',
    '{"Read incidents","Draft summary"}', '{"Change incidents"}', '{"ServiceNow"}', '{internal}',
    'Read-only service account', 'Technology', 1::smallint, null, null, 'low', '{}', '1.2');
  perform pg_temp.new_agent(t, t, 'Technology', 'Cloud Cost Optimiser', 'Shuts down idle cloud resources.', 'langchain',
    'Shut down idle non-production cloud resources under the limit, and recommend the rest.',
    '{"Stop idle resource under limit","Recommend savings"}', '{"Touch production"}', '{"AWS","Azure"}', '{internal}',
    'Cloud role', 'Technology', 3::smallint, 5000, 50, 'medium', '{}', '0.9');

  -- Customer Service (Lucy)
  perform pg_temp.new_agent(l, t, 'Customer Service', 'Card Dispute Assistant', 'Handles card disputes and chargebacks.', 'langchain',
    'Raise card chargebacks for disputes that meet scheme rules and refund customers under the limit.',
    '{"Raise chargeback","Refund under limit"}', '{"Refund above limit","Close a fraud case"}', '{"Card platform","Salesforce"}',
    '{personal,confidential}', 'Service account', 'Cards IT', 3::smallint, 500, 400, 'high', '{"EU AI Act"}', '1.5');
  perform pg_temp.new_agent(l, t, 'Customer Service', 'Agent Assist', 'Suggests replies to contact centre staff. Built into the CRM.', 'vendor_embedded',
    'Suggest replies and next steps to contact centre staff during calls. Staff decide what to say.',
    '{"Suggest reply","Summarise call"}', '{"Send messages to customers"}', '{"Salesforce"}', '{personal}',
    'Vendor managed', 'CX IT', 1::smallint, null, null, 'medium', '{"GDPR"}', 'Vendor release', 'vendor', 'CRM vendor');
  perform pg_temp.new_agent(l, t, 'Customer Service', 'Voice Bot Authentication', 'Authenticates callers by voice.', 'other',
    'Authenticate callers in the phone banking line before they reach an adviser.',
    '{"Verify caller"}', '{"Reset credentials"}', '{"Telephony platform","Core banking"}', '{personal,restricted}',
    null, null, 2::smallint, null, null, 'high', '{"EU AI Act","GDPR"}', '0.2');
end $$;

-- Lifecycles: 17 go live, Cloud Cost Optimiser waits for approval, Voice Bot Authentication is still a draft.
do $$ begin
  if exists (select 1 from public.agents where name = 'Direct Debit Mandate Checker' and status <> 'proposed') then return; end if;
  perform pg_temp.approve('Direct Debit Mandate Checker', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Payment Repair Bot', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Liquidity Buffer Monitor', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Hedge Accounting Assistant', 'james.whitfield@northbridge.demo', array['daniel.okafor@northbridge.demo'], true);
  perform pg_temp.approve('Credit Card Limit Advisor', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Arrears Hardship Classifier', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Trade Finance Document Checker', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Commercial Credit Spreader', 'aisha.rahman@northbridge.demo', array['sara.haddad@northbridge.demo'], true);
  perform pg_temp.approve('Statement Generation Agent', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Mail Room Router', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Cheque Exception Handler', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Transaction Monitoring Triage', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Policy Q&A Assistant', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Code Review Assistant', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Incident Summariser', 'tom.becker@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Card Dispute Assistant', 'lucy.grant@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.approve('Agent Assist', 'lucy.grant@northbridge.demo', array['omar.farouk@northbridge.demo'], true);
  perform pg_temp.act_as('tom.becker@northbridge.demo');
  perform public.submit_agent_for_approval(pg_temp.agent('Cloud Cost Optimiser'));
end $$;

-- Spread registrations and approvals over the past year; every new agent is within its review date.
do $$ begin
  if (select created_at from public.agents where name = 'Direct Debit Mandate Checker') < now() - interval '30 days' then return; end if;
  perform pg_temp.backdate('Direct Debit Mandate Checker', 340, 170, current_date + 52);
  perform pg_temp.backdate('Payment Repair Bot', 300, 120, current_date + 62);
  perform pg_temp.backdate('Liquidity Buffer Monitor', 280, 95, current_date + 87);
  perform pg_temp.backdate('Hedge Accounting Assistant', 230, 75, current_date + 107);
  perform pg_temp.backdate('Credit Card Limit Advisor', 320, 160, current_date + 62);
  perform pg_temp.backdate('Arrears Hardship Classifier', 190, 50, current_date + 132);
  perform pg_temp.backdate('Trade Finance Document Checker', 260, 115, current_date + 67);
  perform pg_temp.backdate('Commercial Credit Spreader', 365, 175, current_date + 47);
  perform pg_temp.backdate('Statement Generation Agent', 420, 140, current_date + 82);
  perform pg_temp.backdate('Mail Room Router', 250, 65, current_date + 117);
  perform pg_temp.backdate('Cheque Exception Handler', 210, 55, current_date + 127);
  perform pg_temp.backdate('Transaction Monitoring Triage', 290, 135, current_date + 47);
  perform pg_temp.backdate('Policy Q&A Assistant', 160, 40, current_date + 142);
  perform pg_temp.backdate('Code Review Assistant', 130, 30, current_date + 152);
  perform pg_temp.backdate('Incident Summariser', 110, 25, current_date + 157);
  perform pg_temp.backdate('Card Dispute Assistant', 270, 100, current_date + 82);
  perform pg_temp.backdate('Agent Assist', 150, 35, current_date + 147);
end $$;

-- A year of completed reviews: older agents were reviewed at their 6-month mark.
do $$ begin
  if exists (select 1 from public.agent_reviews) then return; end if;
  perform pg_temp.past_review('Payment Release Assistant', 'daniel.okafor@northbridge.demo', 200, 'changes_required',
    'Raise the beneficiary-change block to a hard rule; done in v2.3.');
  perform pg_temp.past_review('Invoice Matcher', 'daniel.okafor@northbridge.demo', 150, 'no_change', null);
  perform pg_temp.past_review('Cash Forecast Agent', 'james.whitfield@northbridge.demo', 240, 'no_change', null);
  perform pg_temp.past_review('Affordability Checker', 'sara.haddad@northbridge.demo', 230, 'changes_required',
    'Add the cost-of-living adjustment to the expenditure model.');
  perform pg_temp.past_review('Collections Outreach Agent', 'sara.haddad@northbridge.demo', 210, 'no_change', null);
  perform pg_temp.past_review('Ops Ticket Triage', 'omar.farouk@northbridge.demo', 260, 'no_change', null);
  perform pg_temp.past_review('Reconciliation Exceptions Agent', 'omar.farouk@northbridge.demo', 250, 'changes_required',
    'Limit lowered from £25,000 to £10,000 after the Q1 break review.');
  perform pg_temp.past_review('Statement Generation Agent', 'omar.farouk@northbridge.demo', 140, 'no_change', null);
  perform pg_temp.past_review('Commercial Credit Spreader', 'sara.haddad@northbridge.demo', 175, 'no_change', null);
  perform pg_temp.past_review('Direct Debit Mandate Checker', 'daniel.okafor@northbridge.demo', 170, 'no_change', null);
end $$;

do $$ begin
  perform pg_temp.act_as_system();
  perform public.refresh_alerts();
end $$;

select status, count(*) from public.agents group by status order by status;
