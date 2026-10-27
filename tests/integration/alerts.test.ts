import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Located, Outcome } from "../../probe/state";
import { Store, type Monitor } from "../../probe/store";
import { hashConfirmToken, newConfirmToken, readUnsubscribeToken } from "../../src/lib/alerts/links";
import { rpcFromPg, type Rpc } from "../../src/lib/alerts/rpc";
import { LEASE_SEC, runSender, TELEGRAM_IN_DOUBT, type SenderDeps } from "../../src/lib/alerts/sender";
import { handleUpdate, TELEGRAM_LINK_MAX_AGE_SEC } from "../../src/lib/alerts/telegram";
import type { MemberContact } from "../../src/lib/alerts/clerk";
import { probeDatabase, servicePool } from "../support/probe-database";

/* Alerts (migration 023) against a real Postgres with every migration applied, the sender as the
   server runs it and through the Worker's restricted login (027), with fake Postmark, Telegram and Clerk:
   the outbox trigger on every path that writes an incident, receipts written before anything is
   sent, and one message per receipt through retries, crashes, stale claims and senders racing.
   `PROBE_DATABASE_URL` names the local database, as for the probe's store test; missing, the file
   skips and says so. Nothing here reaches a real provider. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "alerts": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');

const hex = (n: number) => randomBytes(n).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sent = { id: string; to: string; subject: string; text: string; metadata: Record<string, string>; headers: { Name: string; Value: string }[] };

/** Postmark's two endpoints the sender uses, in memory. `plan` scripts the next sends. */
function fakePostmark() {
  const accepted: Sent[] = [];
  const plan: ("503" | "406" | "drop-after-accept" | "never-left")[] = [];
  const state = { delayMs: 0, searchDown: false };
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/email") {
      if (state.delayMs) await sleep(state.delayMs);
      const step = plan.shift();
      if (step === "never-left") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (step === "503") return new Response("{}", { status: 503 });
      if (step === "406") return Response.json({ ErrorCode: 406, Message: "Inactive recipient" }, { status: 422 });
      const body = JSON.parse(String(init?.body));
      const id = randomUUID();
      accepted.push({ id, to: body.To, subject: body.Subject, text: body.TextBody, metadata: body.Metadata, headers: body.Headers });
      if (step === "drop-after-accept") throw new TypeError("socket hang up");
      return Response.json({ ErrorCode: 0, MessageID: id, To: body.To });
    }
    if (u.pathname === "/messages/outbound") {
      if (state.searchDown) return new Response("{}", { status: 500 });
      const key = u.searchParams.get("metadata_delivery");
      const found = accepted.filter((m) => m.metadata.delivery === key);
      return Response.json({ TotalCount: found.length, Messages: found.map((m) => ({ MessageID: m.id })) });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fake, accepted, plan, state };
}

/** Telegram's sendMessage, in memory. */
function fakeTelegram() {
  const sent: { chatId: string; text: string }[] = [];
  const plan: ("403" | "drop-after-accept")[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop();
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (method !== "sendMessage") return Response.json({ ok: false }, { status: 404 });
    const step = plan.shift();
    if (step === "403") return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
    sent.push({ chatId: String(body.chat_id), text: body.text });
    if (step === "drop-after-accept") throw new TypeError("socket hang up");
    return Response.json({ ok: true, result: { message_id: sent.length } });
  }) as typeof globalThis.fetch;
  return { fetch: fake, sent, plan };
}

suite.each(["service_role", "alert_sender"] as const)("alerts (%s sender)", (senderRole) => {
  let probe: Awaited<ReturnType<typeof probeDatabase>>;
  let service: Awaited<ReturnType<typeof probeDatabase>>;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let workerLogin: Awaited<ReturnType<typeof probeDatabase>> | undefined;
  let workerPool: pg.Pool | undefined;
  let senderRpc: Rpc;
  let rpc: Rpc;
  let store: Store;
  const workspaces: string[] = [];
  let ws = "";
  let org = "";
  let app = "";
  let mon: Monitor;
  let pm: ReturnType<typeof fakePostmark>;
  let tg: ReturnType<typeof fakeTelegram>;
  let members: MemberContact[] | null;
  const secret = randomBytes(32);
  const at = Math.floor(Date.now() / 1000) - 3600;

  const deps = (over: Partial<SenderDeps> = {}): SenderDeps => ({
    rpc: senderRpc,
    postmark: { token: "00000000-0000-4000-8000-000000000000", from: "Staygreen alerts <alerts@staygreen.io>", fetch: pm.fetch },
    telegram: { token: "1:fake", fetch: tg.fetch },
    members: async () => members,
    linkSecret: secret,
    appUrl: "https://staygreen.test",
    ...over,
  });
  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const one = async (sql: string, args: unknown[] = []) => (await q(sql, args))[0];
  const receipts = () => q("select * from public.alert_deliveries where workspace_id = $1 order by created_at, id", [ws]);
  const events = () => q("select * from public.alert_events where workspace_id = $1 order by created_at, id", [ws]);
  const addressChannel = async (address: string, confirmed = true) =>
    (await one(
      `insert into public.alert_channels (workspace_id, kind, audience, address, confirmed_at, confirm_hash, confirm_sent_at)
       values ($1, 'email', 'address', $2, $3, $4, now()) returning id`,
      [ws, address, confirmed ? new Date() : null, confirmed ? null : hex(32)],
    )).id as string;
  const membersChannel = async () => (await one("select id from public.alert_channels where workspace_id = $1 and audience = 'members'", [ws])).id as string;
  /** An incident opened by the server, as an owner's write would: the trigger fires for any writer. */
  const openIncident = async () =>
    (await one(
      `insert into public.incidents (workspace_id, monitor_id, title, severity, evidence)
       values ($1, $2, 'API is down', 'down', $3) returning id`,
      [ws, mon.id, JSON.stringify({ request: "GET https://example.com/health", summary: "Answered 503, expected 2xx", status: 503, locations: ["tor1", "sfo3"], snippet: "{\"token\":\"sk_live_abcdefghijklmnop\"}" })],
    )).id as string;
  const recover = async (incident: string, state = "up") => {
    await admin.query("update public.monitors set state = $2, state_since = now() where id = $1", [mon.id, state]);
    await admin.query("update public.incidents set resolved_at = now() where id = $1", [incident]);
  };

  beforeAll(async () => {
    probe = await probeDatabase(url, "probe");
    service = await probeDatabase(url, "service_role");
    admin = probe.admin;
    pool = servicePool(service.probeUrl);
    rpc = rpcFromPg(pool);
    if (senderRole === "alert_sender") {
      workerLogin = await probeDatabase(url, "alert_sender");
      workerPool = new pg.Pool({ connectionString: workerLogin.probeUrl, max: 6 });
      senderRpc = rpcFromPg(workerPool, "alert_sender");
    } else senderRpc = rpc;
    store = Store.connect(probe.probeUrl);
  });

  beforeEach(async () => {
    pm = fakePostmark();
    tg = fakeTelegram();
    members = [];
    org = `org_atest${hex(6)}`;
    ws = (await one("insert into public.workspaces (clerk_org_id) values ($1) returning id", [org])).id;
    workspaces.push(ws);
    app = (await one("insert into public.apps (workspace_id, name) values ($1, 'askone') returning id", [ws])).id;
    await admin.query("insert into public.status_pages (workspace_id, app_id, slug, name) values ($1, $2, $3, 'AskOne')", [ws, app, `a${hex(6)}`]);
    await admin.query(
      `insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config)
       values ($1, $2, 'http', 'API health', 'https://example.com/health', 'example.com', 60, '{"method":"GET","expect":"2xx"}')`,
      [ws, app],
    );
    mon = (await store.loadMonitors()).find((m) => m.workspaceId === ws)!;
  });

  // The sender works across workspaces, as it does in production, so no test may leave anything
  // due for the next one.
  afterEach(async () => {
    if (ws) await admin.query("delete from public.workspaces where id = $1", [ws]);
  });

  afterAll(async () => {
    try {
      if (workspaces.length) await admin.query("delete from public.workspaces where id = any($1)", [workspaces]);
    } finally {
      await store?.close().catch(() => {});
      await pool?.end().catch(() => {});
      await workerPool?.end().catch(() => {});
      await workerLogin?.close().catch(() => {});
      await service?.close().catch(() => {});
      await probe?.close().catch(() => {});
    }
  });

  describe("posture", () => {
    const TABLES = ["alert_channels", "alert_exclusions", "alert_suppressions", "alert_events", "alert_deliveries"];

    it("keeps RLS on with no policy and nothing granted to the browser roles, the probe or ingest", async () => {
      const rows = await q(
        `select c.relname, c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by 1`,
        [TABLES],
      );
      expect(rows).toEqual(TABLES.slice().sort().map((relname) => ({ relname, relrowsecurity: true, policies: 0 })));
      for (const role of ["anon", "authenticated", "probe", "ingest"]) {
        const granted = await q(
          `select c.relname from pg_class c cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p(priv)
            where c.relname = any($1) and c.relnamespace = 'public'::regnamespace and has_table_privilege($2, c.oid, p.priv)`,
          [TABLES, role],
        );
        expect(granted, role).toEqual([]);
      }
    });

    it("makes every alert function security invoker with an empty search path, executable by service_role alone", async () => {
      const rows = await q(`select p.proname, p.prosecdef, p.proconfig,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
          has_function_privilege('probe', p.oid, 'EXECUTE') as probe,
          has_function_privilege('ingest', p.oid, 'EXECUTE') as ingest
        from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname ~ '^(alert_|create_alert_address|confirm_alert_address|create_telegram_link|bind_telegram_chat|telegram_stop)'
        order by 1`);
      expect(rows.map((r) => r.proname)).toEqual([
        "alert_claim", "alert_claim_channels", "alert_events_from_incident", "alert_expand", "alert_mark", "alert_members_channel", "alert_overview",
        "alert_pending_events", "alert_prepare_webhook", "alert_route_matches", "alert_unsubscribe", "bind_telegram_chat", "confirm_alert_address", "create_alert_address",
        "create_telegram_link", "telegram_stop",
      ]);
      for (const r of rows) {
        expect(r, r.proname).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], service: true, anon: false, authenticated: false, probe: false, ingest: false });
      }
    });

    it("refuses a Slack row until Slack is built, and a Telegram channel that claims a chat it wasn't bound to", async () => {
      await expect(admin.query("insert into public.alert_channels (workspace_id, kind, label) values ($1, 'slack', 'x')", [ws]))
        .rejects.toMatchObject({ code: "23514" });
      await expect(admin.query("insert into public.alert_channels (workspace_id, kind, chat_id) values ($1, 'telegram', 42)", [ws]))
        .rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("the outbox trigger", () => {
    it("gives every workspace its members' channel, confirmed", async () => {
      expect(await q("select kind, audience, confirmed_at is not null as confirmed from public.alert_channels where workspace_id = $1", [ws]))
        .toEqual([{ kind: "email", audience: "members", confirmed: true }]);
    });

    it("queues one opening when the probe opens an incident, and its recovery after two passes, in the probe's own transactions", async () => {
      const failAt = (location: string): Located => ({ ok: false, ms: 210, status: 503, location, failure: { kind: "status", message: "Answered 503, expected 2xx" } });
      const pass = (location: string): Outcome => ({ first: { ok: true, ms: 120, slow: false, location } });
      const apply = (outcome: Outcome, offset: number) => store.apply({ monitorId: mon.id, version: mon.version, outcome, atSec: at + offset });
      await apply({ first: failAt("tor1"), confirm: failAt("sfo3") }, 0);
      expect((await events()).map((e) => e.kind)).toEqual(["opened"]);
      await apply({ first: failAt("tor1"), confirm: failAt("sfo3") }, 60); // still down: nothing new
      await apply(pass("tor1"), 120);
      expect((await events()).map((e) => e.kind)).toEqual(["opened"]);
      await apply(pass("sfo3"), 180);
      expect((await events()).map((e) => [e.kind, e.state_after])).toEqual([["opened", null], ["resolved", "up"]]);
    });

    it("queues a heartbeat's opening and its recovery, from the ingest login's ping through the home's judgement", async () => {
      const ingestDb = await probeDatabase(url, "ingest");
      const ingest = new pg.Pool({ connectionString: ingestDb.probeUrl, max: 2 });
      try {
        const token = randomBytes(32).toString("base64url");
        const hash = createHash("sha256").update(token).digest("hex");
        const hb = (await one(
          `insert into public.monitors (workspace_id, app_id, type, name, target, interval_sec, config, heartbeat_token_hash, created_at, updated_at)
           values ($1, $2, 'heartbeat', 'Nightly job', 'in.staygreen.io', 60, $3, $4, now() - interval '1 day', now() - interval '1 day') returning id`,
          [ws, app, { schedule: "* * * * *", tz: "UTC", graceMin: 1, maxRunMin: 30, assertions: [] }, hash],
        )).id as string;
        const record = (kind: "ping" | "fail") => ingest.query("select public.record_heartbeat($1, $2, $3::jsonb, null) as r", [hash, kind, "{}"]);
        const settle = async () => {
          for (let i = 0; i < 20; i++) if ((await store.judgeHeartbeat(hb, "tor1")).applied !== "written") return;
        };
        await record("ping");
        await settle();
        await record("fail");
        await settle();
        await record("ping");
        await settle();
        const rows = await q("select e.kind, e.state_after from public.alert_events e join public.incidents i on i.id = e.incident_id where i.monitor_id = $1 order by e.created_at", [hb]);
        expect(rows).toEqual([{ kind: "opened", state_after: null }, { kind: "resolved", state_after: "up" }]);
      } finally {
        await ingest.end().catch(() => {});
        await ingestDb.close().catch(() => {});
      }
    });

    it("queues nothing for an incident whose transaction rolls back", async () => {
      const c = await admin.connect();
      try {
        await c.query("begin");
        await c.query("insert into public.incidents (workspace_id, monitor_id, title, severity) values ($1, $2, 'x is down', 'down')", [ws, mon.id]);
        expect((await c.query("select count(*)::int as n from public.alert_events where workspace_id = $1", [ws])).rows[0].n).toBe(1);
        await c.query("rollback");
      } finally {
        c.release();
      }
      expect(await events()).toEqual([]);
    });

    it("sends no recovery when an address change closes the incident, or for one never alerted", async () => {
      const inc = await openIncident();
      await admin.query("update public.monitors set state = null, state_since = null where id = $1", [mon.id]);
      await admin.query("update public.incidents set resolved_at = now() where id = $1", [inc]);
      await admin.query("insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at, resolved_at) values ($1, $2, 'old', 'down', now() - interval '1 hour', now())", [ws, mon.id]);
      expect((await events()).map((e) => e.kind)).toEqual(["opened"]);
    });

    it("sends no recovery when a probe closes a stale incident to open the next outage's", async () => {
      const inc = await openIncident();
      await admin.query("update public.monitors set state = 'down', state_since = now() where id = $1", [mon.id]);
      await admin.query("update public.incidents set resolved_at = now() where id = $1", [inc]);
      expect((await events()).map((e) => e.kind)).toEqual(["opened"]);
    });
  });

  describe("receipts", () => {
    it("writes one receipt per channel and member before sending, and expanding again adds none", async () => {
      members = [{ userId: "user_a1", name: "A", email: "a@example.com", timezone: "Europe/Warsaw" }, { userId: "user_b2", name: "B", email: "b@example.com", timezone: null }];
      await addressChannel("oncall@example.com");
      await addressChannel("pending@example.com", false);
      await openIncident();
      const [e] = await events();
      expect(await rpc("alert_expand", { p_event_id: e.id, p_members: null })).toEqual({ status: "members_required" });
      expect(await rpc("alert_expand", { p_event_id: e.id, p_members: ["user_a1", "user_b2"] })).toEqual({ status: "expanded", deliveries: 3 });
      expect(await rpc("alert_expand", { p_event_id: e.id, p_members: ["user_a1", "user_b2", "user_c3"] })).toEqual({ status: "done" });
      expect((await receipts()).map((d) => d.recipient).sort()).toEqual(["channel", "user_a1", "user_b2"]);
      expect(await rpc("alert_pending_events", { p_limit: 10, p_event_id: null })).toEqual([]);
    });

    it("sends each once, to the member's own address in their time zone, with the unsubscribe headers and masked evidence", async () => {
      members = [{ userId: "user_a1", name: "A", email: "a@example.com", timezone: "Europe/Warsaw" }];
      await addressChannel("oncall@example.com");
      await openIncident();
      const r = await runSender(deps());
      expect(r).toMatchObject({ expanded: 1, sent: 2, failed: 0 });
      expect(pm.accepted.map((m) => m.to).sort()).toEqual(["a@example.com", "oncall@example.com"]);
      const member = pm.accepted.find((m) => m.to === "a@example.com")!;
      expect(member.subject).toBe("askone: API is down");
      expect(member.text).toMatch(/Seen from Toronto and San Francisco since \d\d:\d\d CES?T on /);
      expect(member.text).not.toContain("sk_live_abcdefghijklmnop");
      expect(member.text).toContain("https://staygreen.test/app/incidents/inc_");
      const oneClick = member.headers.find((h) => h.Name === "List-Unsubscribe")!.Value;
      expect(member.headers).toContainEqual({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
      const token = /\/api\/alerts\/unsubscribe\/([^>]+)>$/.exec(oneClick)![1];
      expect(readUnsubscribeToken(secret, token)).toBe(member.metadata.delivery);
      expect((await receipts()).map((d) => [d.status, d.provider_id !== null])).toEqual([["sent", true], ["sent", true]]);
      expect(await runSender(deps())).toMatchObject({ sent: 0, expanded: 0 });
      expect(pm.accepted).toHaveLength(2);
    });

    it("leaves the event for the next pass when Clerk can't be read, and sends nothing meanwhile", async () => {
      members = null;
      await openIncident();
      expect(await runSender(deps())).toMatchObject({ expanded: 0, sent: 0 });
      expect((await events())[0].expanded_at).toBeNull();
      members = [{ userId: "user_a1", name: "A", email: "a@example.com", timezone: null }];
      expect(await runSender(deps())).toMatchObject({ expanded: 1, sent: 1 });
    });

    it("sends a recovery only after its opening is settled, and only where the opening went", async () => {
      await addressChannel("oncall@example.com");
      const inc = await openIncident();
      pm.plan.push("503");
      expect(await runSender(deps())).toMatchObject({ retrying: 1, sent: 0 });
      await recover(inc);
      await addressChannel("late@example.com"); // added after the opening: no lone "recovered"
      expect(await runSender(deps())).toMatchObject({ expanded: 1, sent: 0 }); // the opening's retry isn't due; the recovery waits
      await admin.query("update public.alert_deliveries set next_at = now() where workspace_id = $1 and status = 'pending'", [ws]);
      const r = await runSender(deps());
      expect(r.sent).toBe(2);
      expect(pm.accepted.map((m) => m.subject)).toEqual(["askone: API is down", "askone: API health recovered"]);
      expect(pm.accepted.every((m) => m.to === "oncall@example.com")).toBe(true);
    });
  });

  describe("exactly once", () => {
    const due = () => admin.query("update public.alert_deliveries set next_at = now() where workspace_id = $1 and status = 'pending'", [ws]);
    const leaseOver = () =>
      admin.query(`update public.alert_deliveries set claimed_at = now() - make_interval(secs => $2) where workspace_id = $1 and status = 'sending'`, [ws, LEASE_SEC + 1]);

    it("retries a send Postmark refused for now, and sends it once", async () => {
      await addressChannel("oncall@example.com");
      await openIncident();
      pm.plan.push("503", "never-left");
      expect(await runSender(deps())).toMatchObject({ retrying: 1 });
      expect((await receipts())[0]).toMatchObject({ status: "pending", attempts: 1, detail: "Postmark answered 503." });
      await due();
      expect(await runSender(deps())).toMatchObject({ retrying: 1 });
      await due();
      expect(await runSender(deps())).toMatchObject({ sent: 1 });
      expect(pm.accepted).toHaveLength(1);
      expect((await receipts())[0]).toMatchObject({ status: "sent", attempts: 3 });
    });

    it("never resends a message whose answer was lost: the next sender finds it in Postmark's search", async () => {
      await addressChannel("oncall@example.com");
      await openIncident();
      pm.plan.push("drop-after-accept");
      expect(await runSender(deps())).toMatchObject({ inDoubt: 1, sent: 0 });
      expect((await receipts())[0].status).toBe("sending");
      expect(await runSender(deps())).toMatchObject({ sent: 0, reconciled: 0 }); // still under its lease
      await leaseOver();
      expect(await runSender(deps())).toMatchObject({ sent: 0, reconciled: 1 });
      expect(pm.accepted).toHaveLength(1);
      expect((await receipts())[0]).toMatchObject({ status: "sent", provider_id: pm.accepted[0].id });
    });

    it("sends once a claim whose sender crashed before Postmark, and waits while the search can't answer", async () => {
      await addressChannel("oncall@example.com");
      await openIncident();
      const [e] = await events();
      await rpc("alert_expand", { p_event_id: e.id, p_members: [] });
      const claimed = (await rpc("alert_claim", { p_claim: "crashed_sender", p_limit: 10, p_lease_sec: LEASE_SEC, p_event_id: null })) as unknown[];
      expect(claimed).toHaveLength(1);
      await leaseOver();
      pm.state.searchDown = true;
      expect(await runSender(deps())).toMatchObject({ inDoubt: 1, sent: 0 });
      pm.state.searchDown = false;
      await leaseOver();
      expect(await runSender(deps())).toMatchObject({ sent: 1 });
      expect(pm.accepted).toHaveLength(1);
      // The crashed sender comes back and tries to settle what is no longer its claim.
      const [d] = await receipts();
      expect(await rpc("alert_mark", { p_id: d.id, p_claim: "crashed_sender", p_status: "failed", p_provider_id: null, p_detail: "late", p_retry_sec: null, p_redirected: null })).toBe(false);
      expect((await receipts())[0].status).toBe("sent");
    });

    it("sends each receipt once when five senders race over the same receipts", async () => {
      for (let i = 0; i < 12; i++) await addressChannel(`r${i}@example.com`);
      await openIncident();
      pm.state.delayMs = 20;
      // During cutover the old service-role runner may still race the narrow Worker login.
      const reports = await Promise.all(Array.from({ length: 5 }, (_, i) => runSender(deps(i === 0 ? { rpc } : {}), { batch: 3 })));
      expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(12);
      expect(pm.accepted).toHaveLength(12);
      expect(new Set(pm.accepted.map((m) => m.metadata.delivery)).size).toBe(12);
      expect((await receipts()).every((d) => d.status === "sent")).toBe(true);
    });

    it("fails a refused message for good, in our words, and doesn't retry it", async () => {
      await addressChannel("oncall@example.com");
      await openIncident();
      pm.plan.push("406");
      expect(await runSender(deps())).toMatchObject({ failed: 1 });
      await due();
      expect(await runSender(deps())).toMatchObject({ sent: 0, failed: 0 });
      expect((await receipts())[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("error 406") });
    });

    it("hands back a receipt whose claim grew stale before it was sent", async () => {
      await addressChannel("oncall@example.com");
      await openIncident();
      let t = Date.now();
      const r = await runSender(deps({ now: () => (t += 70_000) }), { deadlineMs: 10 * 60_000 });
      expect(r.sent).toBe(0);
      expect(r.released).toBeGreaterThan(0);
      expect(pm.accepted).toHaveLength(0);
      expect((await receipts())[0].status).toBe("pending");
    });
  });

  describe("who gets it", () => {
    it("skips what was unsubscribed, unconfirmed or excluded after its receipt was written", async () => {
      members = [{ userId: "user_a1", name: "A", email: "a@example.com", timezone: null }, { userId: "user_b2", name: "B", email: "b@example.com", timezone: null }];
      const ch = await addressChannel("oncall@example.com");
      await openIncident();
      const [e] = await events();
      await rpc("alert_expand", { p_event_id: e.id, p_members: ["user_a1", "user_b2"] });
      const rows = await receipts();
      const a1 = rows.find((d) => d.recipient === "user_a1")!;
      const addr = rows.find((d) => d.channel_id === ch)!;
      expect(await rpc("alert_unsubscribe", { p_delivery_id: a1.id })).toEqual({ status: "unsubscribed", audience: "members" });
      expect(await rpc("alert_unsubscribe", { p_delivery_id: a1.id })).toEqual({ status: "already", audience: "members" });
      expect(await rpc("alert_unsubscribe", { p_delivery_id: addr.id })).toEqual({ status: "unsubscribed", audience: "address" });
      const r = await runSender(deps());
      expect(r).toMatchObject({ sent: 1, skipped: 2 });
      expect(pm.accepted.map((m) => m.to)).toEqual(["b@example.com"]);
      // Its recovery reaches only B.
      await recover(await one("select id from public.incidents where monitor_id = $1", [mon.id]).then((x) => x.id));
      await runSender(deps());
      expect(pm.accepted.map((m) => m.to)).toEqual(["b@example.com", "b@example.com"]);
    });

    it("alerts no channel for an app it excludes", async () => {
      const ch = await addressChannel("oncall@example.com");
      await admin.query("insert into public.alert_exclusions (channel_id, app_id, workspace_id) values ($1, $2, $3), ($4, $2, $3)", [ch, app, ws, await membersChannel()]);
      members = null; // never read: no channel needs the members
      await openIncident();
      expect(await runSender(deps())).toMatchObject({ expanded: 1, sent: 0 });
      expect(await receipts()).toEqual([]);
    });

    it("confirms an address once, within its window, and only on Builder", async () => {
      const t = newConfirmToken();
      await expect(rpc("create_alert_address", { p_workspace_id: ws, p_address: "x@example.com", p_confirm_hash: t.hash, p_created_by: "user_a1", p_notify_teammates: false }))
        .rejects.toMatchObject({ code: "P0001" });
      await expect(rpc("create_alert_address", { p_workspace_id: ws, p_address: "x@example.com", p_confirm_hash: t.hash, p_created_by: "user_a1", p_notify_teammates: null }))
        .rejects.toMatchObject({ code: "22004" });
      const row = (await rpc("create_alert_address", { p_workspace_id: ws, p_address: " X@Example.com ", p_confirm_hash: t.hash, p_created_by: "user_a1", p_notify_teammates: true })) as { id: string; address: string; confirmed_at: string | null };
      expect(row).toMatchObject({ address: "x@example.com", confirmed_at: null });
      await openIncident();
      await runSender(deps());
      expect(pm.accepted).toHaveLength(0); // unconfirmed: no receipt at all
      expect(await rpc("confirm_alert_address", { p_confirm_hash: hashConfirmToken("nope"), p_max_age_sec: 3600 })).toEqual({ status: "missing" });
      expect(await rpc("confirm_alert_address", { p_confirm_hash: t.hash, p_max_age_sec: 3600 })).toEqual({ status: "confirmed", channelId: row.id });
      expect(await rpc("confirm_alert_address", { p_confirm_hash: t.hash, p_max_age_sec: 3600 })).toEqual({ status: "missing" });
      const late = newConfirmToken();
      await rpc("create_alert_address", { p_workspace_id: ws, p_address: "late@example.com", p_confirm_hash: late.hash, p_created_by: "user_a1", p_notify_teammates: true });
      await admin.query("update public.alert_channels set confirm_sent_at = now() - interval '2 hours' where confirm_hash = $1", [late.hash]);
      expect(await rpc("confirm_alert_address", { p_confirm_hash: late.hash, p_max_age_sec: 3600 })).toEqual({ status: "expired" });
      await expect(rpc("create_alert_address", { p_workspace_id: ws, p_address: "x@example.com", p_confirm_hash: newConfirmToken().hash, p_created_by: "user_a1", p_notify_teammates: true }))
        .rejects.toMatchObject({ code: "23505" });
    });

    it("tests a channel through the same path: the members' test reaches only the member who asked", async () => {
      members = [{ userId: "user_a1", name: "A", email: "a@example.com", timezone: null }, { userId: "user_b2", name: "B", email: "b@example.com", timezone: null }];
      const ev = (await one("insert into public.alert_events (workspace_id, kind, channel_id, requested_by) values ($1, 'test', $2, 'user_b2') returning id", [ws, await membersChannel()])).id;
      const r = await runSender(deps(), { eventId: ev });
      expect(r).toMatchObject({ expanded: 1, sent: 1 });
      expect(pm.accepted.map((m) => [m.to, m.subject])).toEqual([["b@example.com", "Staygreen: test alert"]]);
    });

    it("keeps a receipt when its channel is removed, and sends it nowhere", async () => {
      const ch = await addressChannel("oncall@example.com");
      await openIncident();
      const [e] = await events();
      await rpc("alert_expand", { p_event_id: e.id, p_members: [] });
      await admin.query("delete from public.alert_channels where id = $1", [ch]);
      expect(await runSender(deps())).toMatchObject({ skipped: 1, sent: 0 });
      expect((await receipts())[0]).toMatchObject({ channel_id: null, status: "skipped", detail: "Its channel was removed before it went." });
    });
  });

  describe("Telegram", () => {
    const link = async (createdBy = "user_a1") => {
      const t = newConfirmToken();
      const id = (await rpc("create_telegram_link", { p_workspace_id: ws, p_code_hash: t.hash, p_created_by: createdBy })) as string;
      return { ...t, id };
    };
    const start = (code: string, chatId = 4242, extra: Record<string, unknown> = {}) => ({
      update_id: 1,
      message: { message_id: 1, chat: { id: chatId, type: "private", username: "alex", ...extra }, text: `/start ${code}` },
    });
    const updateDeps = () => ({
      rpc: senderRpc,
      telegram: { token: "1:fake", fetch: tg.fetch },
      appUrl: "https://staygreen.test",
      deliver: (eventId: string) => runSender(deps(), { eventId }),
    });

    it("binds the chat that pressed Start, once, and its test alert arrives there through a receipt", async () => {
      const l = await link();
      expect(await handleUpdate(updateDeps(), start(l.token))).toBe("bound");
      expect(await one("select kind, chat_id::text, label, confirmed_at is not null as confirmed, confirm_hash from public.alert_channels where id = $1", [l.id]))
        .toEqual({ kind: "telegram", chat_id: "4242", label: "@alex", confirmed: true, confirm_hash: null });
      expect(tg.sent).toHaveLength(1);
      expect(tg.sent[0]).toMatchObject({ chatId: "4242", text: expect.stringContaining("Staygreen: test alert") });
      expect((await receipts()).map((d) => [d.event, d.status, d.provider_id])).toEqual([["test", "sent", "1"]]);
      // The same link again, from any chat: used.
      expect(await handleUpdate(updateDeps(), start(l.token, 777))).toBe("missing");
      expect(tg.sent.at(-1)).toMatchObject({ chatId: "777", text: expect.stringContaining("already used") });
      expect(await q("select id from public.alert_channels where workspace_id = $1 and kind = 'telegram'", [ws])).toHaveLength(1);
    });

    it("refuses an expired link, and replaces a member's waiting link with their next one", async () => {
      const first = await link();
      const second = await link();
      expect(await q("select id from public.alert_channels where workspace_id = $1 and kind = 'telegram'", [ws])).toEqual([{ id: second.id }]);
      expect(await handleUpdate(updateDeps(), start(first.token))).toBe("missing");
      await admin.query("update public.alert_channels set confirm_sent_at = now() - make_interval(secs => $2) where id = $1", [second.id, TELEGRAM_LINK_MAX_AGE_SEC + 5]);
      expect(await handleUpdate(updateDeps(), start(second.token))).toBe("expired");
      expect(tg.sent.map((m) => m.text)).toEqual([expect.stringContaining("already used"), expect.stringContaining("expired")]);
    });

    it("alerts a bound chat on incidents, stops on /stop, and binding it again resubscribes it", async () => {
      const l = await link();
      await handleUpdate(updateDeps(), start(l.token));
      await openIncident();
      await runSender(deps());
      expect(tg.sent.at(-1)!.text).toMatch(/^askone: API is down\n\nGET https:\/\/example.com\/health: Answered 503/);
      expect(tg.sent.at(-1)!.text).toContain("Send /stop to stop Staygreen alerts in this chat.");
      expect(await handleUpdate(updateDeps(), { update_id: 2, message: { chat: { id: 4242, type: "private" }, text: "/stop" } })).toBe("stopped");
      const again = await link();
      expect(await handleUpdate(updateDeps(), start(again.token))).toBe("rebound");
      const rows = await q("select id, unsubscribed_at from public.alert_channels where workspace_id = $1 and kind = 'telegram'", [ws]);
      expect(rows).toEqual([{ id: l.id, unsubscribed_at: null }]);
    });

    it("never resends a Telegram message whose answer was lost, and stops a chat that blocked the bot", async () => {
      const l = await link();
      await handleUpdate(updateDeps(), start(l.token));
      const before = tg.sent.length;
      await openIncident();
      tg.plan.push("drop-after-accept");
      expect(await runSender(deps())).toMatchObject({ failed: 1, sent: 0 });
      const opened = (await receipts()).find((d) => d.event === "opened")!;
      expect(opened).toMatchObject({ status: "failed", detail: TELEGRAM_IN_DOUBT });
      await admin.query("update public.alert_deliveries set next_at = now() where id = $1", [opened.id]);
      await runSender(deps());
      expect(tg.sent.length).toBe(before + 1);
      // Blocked: the receipt fails, and the chat stops.
      await admin.query("update public.monitors set state = 'up', state_since = now() where id = $1", [mon.id]);
      await admin.query("update public.incidents set resolved_at = now() where monitor_id = $1", [mon.id]);
      tg.plan.push("403");
      await openIncident();
      await runSender(deps());
      expect((await one("select unsubscribed_at from public.alert_channels where id = $1", [l.id])).unsubscribed_at).not.toBeNull();
    });

    it("stops every channel bound to a chat when the bot is removed from it", async () => {
      const l = await link();
      await handleUpdate(updateDeps(), start(l.token, -100123, { type: "supergroup", title: "Ops" }));
      expect((await one("select label from public.alert_channels where id = $1", [l.id])).label).toBe("Ops");
      expect(await handleUpdate(updateDeps(), { update_id: 3, my_chat_member: { chat: { id: -100123, type: "supergroup" }, new_chat_member: { status: "left" } } })).toBe("removed");
      expect((await one("select unsubscribed_at from public.alert_channels where id = $1", [l.id])).unsubscribed_at).not.toBeNull();
    });
  });
});
