-- 021: what an app's own site gives its first status page.
--
-- The suggestion run reads an app's page once (`docs/flows.md § Suggested checks`). Besides the
-- checks it offers and the icon it imports, it now finds the site's brand colour, and a new
-- status page for the app starts with that colour as its accent and the app's icon as its logo
-- and favicon (`addPage`). Both stay the builder's to change in the page's editor.
--
-- `apps.accent`: the colour found, six lowercase hex digits, or null when nothing on the page
-- read as a brand colour. Only `suggestChecks` writes it; nothing but a new page reads it, so a
-- page made before keeps the accent it has.
--
-- `app_logos.favicon_*`: a 48 px PNG copy of the app's logo, made in the builder's browser from
-- the same source image as the 96 px logo, because the server never decodes or resizes an image
-- it stores (`docs/architecture.md § Page images`). A new page copies both into `page_assets`; a
-- logo stored before this migration has no copy, and its page's tab falls back to the logo
-- (`faviconOf`). The pair is both set or both null, and the copy is a PNG, the only format a
-- page's favicon slot stores.
--
-- Additive only: the deployed code reads neither column, and `create_app` still returns the row.
-- Idempotent, and never edited after it is applied.

alter table public.apps
  add column if not exists accent text check (accent is null or accent ~ '^#[0-9a-f]{6}$');

alter table public.app_logos
  add column if not exists favicon_mime text check (favicon_mime is null or favicon_mime = 'image/png');

alter table public.app_logos
  add column if not exists favicon_content bytea check (favicon_content is null or octet_length(favicon_content) between 1 and 524288);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_logos_favicon_pair' and conrelid = 'public.app_logos'::regclass) then
    alter table public.app_logos
      add constraint app_logos_favicon_pair check ((favicon_mime is null) = (favicon_content is null));
  end if;
end;
$$;
