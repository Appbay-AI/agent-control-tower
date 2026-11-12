-- Task 4.8: first fill of the data-authority findings (its own migration: the alert kind it uses was added in the
-- previous one, and a new enum value cannot be used in the transaction that adds it).
-- Today's findings, without phone alerts (they are not news).
do $$
declare x uuid;
begin
  for x in select id from public.agents where status <> 'retired' loop
    perform public.authority_recheck(x, false);
  end loop;
end $$;
