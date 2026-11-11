-- Microsoft switched off (11 Nov 2026): Copilot Studio only blocks published agents and the free trial cannot publish,
-- so the product is Appian-only for now. The Microsoft tables and functions stay (switching back on needs no database
-- change), but nothing usable is kept: the admin's renewable sign-in, sign-ins in progress and the client secret are
-- removed. Switching back on: the client secret comes back with the next Database migrations run, and an admin
-- presses Connect Microsoft again (HANDOVER.md, "Switching Microsoft back on").
delete from public.microsoft_connection where id;
delete from public.microsoft_signins where state_hash is not null;
update public.microsoft_app set client_secret = null, secret_set_at = null, updated_at = now() where id;
update public.microsoft_checks set finished_at = now(), ok = false, message = 'Microsoft was switched off.'
 where finished_at is null;
