// Public test-only capability verifier. No production connection or provisioning logic.
import pg from "pg";
export const SENDER_FUNCTIONS = [
  "alert_sender.alert_claim(text,integer,integer,text)",
  "alert_sender.alert_claim_channels(text,integer,integer,text)",
  "alert_sender.alert_expand(text,text[])",
  "alert_sender.alert_mark(text,text,text,text,text,integer,boolean)",
  "alert_sender.alert_pending_events(integer,text)",
  "alert_sender.alert_prepare_webhook(text,text,text)",
  "alert_sender.bind_telegram_chat(text,integer,bigint,text)",
  "alert_sender.telegram_stop(bigint)",
];

export async function checkSenderLogin(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows: [r] } = await c.query(`select
      exists(select 1 from pg_roles where rolname in (current_user,'alert_sender') and
        (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)) as elevated,
      exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname='alert_sender')) as group_memberships,
      (select array_agg(r.rolname::text order by r.rolname) from pg_auth_members m join pg_roles r on r.oid=m.roleid
        where m.member=(select oid from pg_roles where rolname=current_user)) as memberships,
      exists(select 1 from pg_class t where t.relnamespace in ('public'::regnamespace,'alert_sender'::regnamespace) and
        case when t.relkind='S' then has_sequence_privilege(current_user,t.oid,'USAGE,SELECT,UPDATE')
          when t.relkind in ('r','p','v','m') then has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') else false end) as tables,
      exists(select 1 from pg_namespace n where n.nspname in ('public','alert_sender') and has_schema_privilege(current_user,n.oid,'CREATE')) as creates`);
    const { rows } = await c.query(`select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','alert_sender') and has_function_privilege(current_user,p.oid,'EXECUTE') order by 1`);
    // oidvectortypes includes spaces after commas, unlike regprocedure's spelling.
    const signatures = rows.map((v) => String(v.signature).replaceAll(", ", ","));
    if (r.elevated || r.group_memberships || r.tables || r.creates || JSON.stringify(r.memberships) !== JSON.stringify(["alert_sender"]) ||
        JSON.stringify(signatures) !== JSON.stringify(SENDER_FUNCTIONS)) throw new Error();
  } finally { await c.end(); }
}
