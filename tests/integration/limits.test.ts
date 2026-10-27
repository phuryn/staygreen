import { afterAll, beforeAll, expect, it } from "vitest";
import { limits, type PlanId } from "@/lib/plans";
import { parseMonitorDraft, type MonitorDraft } from "@/lib/monitor-input";
import {
  clientFor,
  describeTarget,
  NOT_FOUND,
  dnsMonitor,
  expectOk,
  expectRefused,
  Fixtures,
  heartbeatMonitor,
  hex,
  httpMonitor,
  LIMITS_REQUIRED,
  monitorLimitArgs,
  raised,
  readTarget,
  refusalOf,
  savePageArgs,
  testSlug,
  testTokenHash,
  uniqueViolation,
} from "../support/integration";

/* The plan limits the database enforces itself (`spec.md § 1`, `AGENTS.md
   § 2.8`: checked inside the transaction that creates the row, with the
   workspace row locked). Each limit is called directly at its boundary, with the
   numbers from `src/lib/plans.ts` — the module the screens and `actions.ts` read —
   so the plan table and the SQL can't drift apart unnoticed: the last allowed
   row is created through the function, and the next is refused.

   Rows below the boundary are inserted straight into the table: they are what
   the function counts, and the call under test still goes through the function.
   A missing limit is refused, never read as "no limit" (`AGENTS.md § 1.1`).

   Apps are counted by `create_app` (016), which `addApp` calls; the fixtures insert
   apps directly, so a suite that needs several in one workspace isn't held to it.
   A workspace past the limit, one moved back to Free, keeps every app it has. */

const target = readTarget();

const PLANS: PlanId[] = ["free", "builder"];

describeTarget("limits: the database refuses past every plan limit, at the boundary", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);

  afterAll(async () => {
    await fx.cleanup();
  });

  /** A fresh workspace and app, so no limit sees another test's rows. */
  async function fresh() {
    const ws = await fx.workspace();
    const app = await fx.app(ws.id);
    return { ws, app };
  }

  const dnsRow = (ws: string, app: string) => ({ workspace_id: ws, app_id: app, type: "dns", name: `itest seed ${hex(3)}`, target: "example.com", interval_sec: 600 });
  const countOf = async (ws: string, filter: (q: any) => any = (q) => q) => {
    const res = await filter(db.from("monitors").select("id", { count: "exact", head: true }).eq("workspace_id", ws));
    if (res.error) throw new Error(`count: ${res.error.code}`);
    return res.count as number;
  };

  // ── monitors ────────────────────────────────────────────────────────────────

  for (const plan of PLANS) {
    const L = limits[plan];

    it(`monitors (${plan}): monitor #${L.monitors} is created and #${L.monitors + 1} refused`, async () => {
      const { ws, app } = await fresh();
      await fx.seedMonitors(Array.from({ length: L.monitors - 1 }, () => dnsRow(ws.id, app.id)));
      expectOk(await db.rpc("create_monitor", dnsMonitor(ws.id, app.id, L)));
      expect(await countOf(ws.id)).toBe(L.monitors);
      expectRefused(await db.rpc("create_monitor", dnsMonitor(ws.id, app.id, L)), raised("monitor_limit"));
      expect(await countOf(ws.id)).toBe(L.monitors);
    });

    it(`heartbeats (${plan}): heartbeat #${L.heartbeats} is created and #${L.heartbeats + 1} refused`, async () => {
      const { ws, app } = await fresh();
      await fx.seedMonitors(
        Array.from({ length: L.heartbeats - 1 }, () => ({ ...dnsRow(ws.id, app.id), type: "heartbeat", interval_sec: 3600, heartbeat_token_hash: testTokenHash() })),
      );
      expectOk(await db.rpc("create_monitor", heartbeatMonitor(ws.id, app.id, L)));
      expectRefused(await db.rpc("create_monitor", heartbeatMonitor(ws.id, app.id, L)), raised("heartbeat_limit"));
      expect(await countOf(ws.id, (q) => q.eq("type", "heartbeat"))).toBe(L.heartbeats);
    });

    it(`assertions per HTTP monitor (${plan}): ${L.assertions} are allowed and ${L.assertions + 1} refused`, async () => {
      const { ws, app } = await fresh();
      const assertions = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `$.a${i}`, op: "==", value: "ok" }));
      const at = httpMonitor(ws.id, app.id, `itest-${hex(4)}.example.com`, L, { p_config: { method: "GET", assertions: assertions(L.assertions) } });
      expectOk(await db.rpc("create_monitor", at));
      const past = httpMonitor(ws.id, app.id, `itest-${hex(4)}.example.com`, L, { p_config: { method: "GET", assertions: assertions(L.assertions + 1) } });
      expectRefused(await db.rpc("create_monitor", past), raised("assertion_limit"));
    });

    it(`assertions per heartbeat (${plan}): ${L.heartbeatAssertions} are allowed and ${L.heartbeatAssertions + 1} refused`, async () => {
      const { ws, app } = await fresh();
      const assertions = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `rows_${i}`, op: ">", value: "0" }));
      expectOk(await db.rpc("create_monitor", heartbeatMonitor(ws.id, app.id, L, { p_config: { schedule: "0 6 * * *", assertions: assertions(L.heartbeatAssertions) } })));
      expectRefused(
        await db.rpc("create_monitor", heartbeatMonitor(ws.id, app.id, L, { p_config: { schedule: "0 6 * * *", assertions: assertions(L.heartbeatAssertions + 1) } })),
        raised("assertion_limit"),
      );
    });

    it(`HTTP and TCP interval (${plan}): every ${L.httpIntervalMin} min is allowed, one second less refused`, async () => {
      const { ws, app } = await fresh();
      const min = L.httpIntervalMin * 60;
      for (const type of ["http", "tcp"]) {
        const host = `itest-${hex(4)}.example.com`;
        const as = type === "tcp" ? { p_type: type, p_target: `${host}:443`, p_config: { host, port: 443, tls: true } } : { p_type: type };
        expectOk(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L, { ...as, p_interval_sec: min })));
        expectRefused(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L, { ...as, p_interval_sec: min - 1 })), raised("interval_not_allowed"));
      }
    });

    it(`apps (${plan}): app #${L.apps} is created and #${L.apps + 1} refused`, async () => {
      const ws = await fx.workspace();
      for (let i = 0; i < L.apps - 1; i++) await fx.app(ws.id);
      const app = (name: string) => ({ p_workspace_id: ws.id, p_name: ` ${name} `, p_url: " https://example.com/ ", p_max_apps: L.apps });
      const made = expectOk(await db.rpc("create_app", app("itest last app")));
      expect({ name: made.name, url: made.url, workspace_id: made.workspace_id }).toEqual({ name: "itest last app", url: "https://example.com/", workspace_id: ws.id });
      expectRefused(await db.rpc("create_app", app("itest one too many")), raised("app_limit"));
      const count = await db.from("apps").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id);
      expect(count.count).toBe(L.apps);
    });

    it(`status pages (${plan}): page #${L.statusPages} is created and #${L.statusPages + 1} refused`, async () => {
      const ws = await fx.workspace();
      const apps = [];
      for (let i = 0; i <= L.statusPages; i++) apps.push(await fx.app(ws.id));
      if (L.statusPages > 1) {
        const seed = await db
          .from("status_pages")
          .insert(apps.slice(0, L.statusPages - 1).map((a) => ({ workspace_id: ws.id, app_id: a.id, slug: testSlug(), name: "itest seed page" })));
        expect(seed.error).toBeNull();
      }
      const page = (appId: string) => ({ p_workspace_id: ws.id, p_app_id: appId, p_slug: testSlug(), p_name: "itest page", p_logo_text: "", p_homepage: null, p_max_pages: L.statusPages });
      expectOk(await db.rpc("create_status_page", page(apps[L.statusPages - 1].id)));
      expectRefused(await db.rpc("create_status_page", page(apps[L.statusPages].id)), raised("page_limit"));
      const count = await db.from("status_pages").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id);
      expect(count.count).toBe(L.statusPages);
    });
  }

  it("create_app refuses a missing app limit and an unknown workspace, and stores an empty address as none", async () => {
    const ws = await fx.workspace();
    expectRefused(await db.rpc("create_app", { p_workspace_id: ws.id, p_name: "itest", p_url: null, p_max_apps: null }), LIMITS_REQUIRED);
    expectRefused(await db.rpc("create_app", { p_workspace_id: `ws_${"0".repeat(24)}`, p_name: "itest", p_url: null, p_max_apps: 1 }), NOT_FOUND);
    const made = expectOk(await db.rpc("create_app", { p_workspace_id: ws.id, p_name: "itest", p_url: "  ", p_max_apps: 1 }));
    expect(made.url).toBeNull();
  });

  it("create_app: a workspace past the app limit keeps every app, and can't add another", async () => {
    // A Builder workspace with three apps, moved back to Free.
    const ws = await fx.workspace();
    for (let i = 0; i < 3; i++) await fx.app(ws.id);
    expectRefused(await db.rpc("create_app", { p_workspace_id: ws.id, p_name: "itest", p_url: null, p_max_apps: limits.free.apps }), raised("app_limit"));
    const count = await db.from("apps").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id);
    expect(count.count).toBe(3);
  });

  it(`monitors per host (free): monitor #${limits.free.perHost} on a host is created and #${(limits.free.perHost as number) + 1} refused`, async () => {
    const L = limits.free;
    const perHost = L.perHost as number;
    const { ws, app } = await fresh();
    const host = `itest-${hex(4)}.example.com`;
    // perHost - 1 monitors already on the host, plus its automatic SSL monitor, which doesn't count.
    await fx.seedMonitors([
      ...Array.from({ length: perHost - 1 }, () => ({ ...dnsRow(ws.id, app.id), type: "http", target: `https://${host}/`, target_host: host, interval_sec: 180 })),
      { ...dnsRow(ws.id, app.id), type: "ssl", auto: true, target: host, target_host: host, interval_sec: 21600 },
    ]);
    expectOk(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L)));
    expectRefused(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L, { p_type: "tcp", p_target: `${host}:443`, p_config: { host, port: 443, tls: true } })), raised("host_limit"));
    expect(await countOf(ws.id, (q) => q.eq("target_host", host).neq("type", "ssl"))).toBe(perHost);
    // Another host in the same workspace is its own count.
    expectOk(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, `itest-${hex(4)}.example.com`, L)));
  });

  it("monitors per host (free): the database counts the host it derives, so passing none or another one is refused", async () => {
    // `AGENTS.md § 2.8`: "Free allows at most 5 monitors per target host per workspace,
    // enforced in the database." create_monitor derives the host from the target
    // (`monitor_target_host`, by `monitor-input.ts`'s rules) and refuses a caller's that disagrees.
    const L = limits.free;
    const perHost = L.perHost as number;
    const { ws, app } = await fresh();
    const host = `itest-${hex(4)}.example.com`;
    await fx.seedMonitors(Array.from({ length: perHost }, () => ({ ...dnsRow(ws.id, app.id), type: "http", target: `https://${host}/`, target_host: host, interval_sec: 180 })));
    expectRefused(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L)), raised("host_limit"));
    for (const p_target_host of [null, `other-${hex(4)}.example.com`, host.toUpperCase()]) {
      expectRefused(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L, { p_target_host })), raised("host_mismatch"));
    }
    expect(await countOf(ws.id, (q) => q.eq("target_host", host).neq("type", "ssl"))).toBe(perHost);
  });

  it("the host the database derives is the one monitor-input.ts stores, type by type", async () => {
    const appId = `app_${"0".repeat(24)}`;
    const drafts: MonitorDraft[] = [
      { type: "http", appId, name: "", url: "https://API.Example.com/health", method: "GET", expect: "2xx", keyword: "", slowMs: 2000, assertions: [], headers: [] },
      { type: "http", appId, name: "", url: "https://api.example.com:8443/x?y=1#z", method: "GET", expect: "2xx", keyword: "", slowMs: 2000, assertions: [], headers: [] },
      { type: "http", appId, name: "", url: "http://api.example.com./", method: "GET", expect: "2xx", keyword: "", slowMs: 2000, assertions: [], headers: [] },
      { type: "http", appId, name: "", url: "https://[2606:4700:4700::1111]/", method: "GET", expect: "2xx", keyword: "", slowMs: 2000, assertions: [], headers: [] },
      { type: "ssl", appId, name: "", host: "Api.Example.com" },
      { type: "tcp", appId, name: "", host: "db.example.com", port: 5432, tls: false },
      { type: "dns", appId, name: "", record: "TXT", recordName: "_dmarc.Example.com.", expected: "v=DMARC1" },
      { type: "dns", appId, name: "", record: "A", recordName: "www.example.com", expected: "93.184.216.34" },
      { type: "heartbeat", appId, name: "", schedule: "0 6 * * *", tz: "UTC", graceMin: 10, maxRunMin: 60, assertions: [] },
    ];
    for (const draft of drafts) {
      const parsed = parseMonitorDraft(draft);
      if (!parsed.ok) throw new Error(`${JSON.stringify(draft)} was refused: ${JSON.stringify(parsed.fieldErrors)}`);
      const { type, target, targetHost } = parsed.row;
      const { data, error } = await db.rpc("monitor_target_host", { p_type: type, p_target: target });
      expect(error, `${type} ${target}`).toBeNull();
      expect(data, `${type} ${target}`).toBe(targetHost);
    }
    // Shapes the app never writes have no host, so create_monitor refuses them.
    for (const [p_type, p_target] of [["http", "https://user@api.example.com/"], ["tcp", "db.example.com"], ["dns", "TXT _a._b"]]) {
      const { data } = await db.rpc("monitor_target_host", { p_type, p_target });
      expect(data, `${p_type} ${p_target}`).toBeNull();
    }
  });

  it("monitors per host (builder): fair use is the monitor cap, as addMonitor passes it", () => {
    expect(limits.builder.perHost).toBe("fair use");
    expect(monitorLimitArgs(limits.builder).p_per_host).toBe(limits.builder.monitors);
  });

  it("automatic SSL monitors count against neither the monitor limit nor the per-host limit", async () => {
    const L = limits.free;
    const { ws, app } = await fresh();
    await fx.seedMonitors([
      ...Array.from({ length: L.monitors - 1 }, () => dnsRow(ws.id, app.id)),
      ...Array.from({ length: 3 }, () => {
        const h = `itest-${hex(4)}.example.com`;
        return { ...dnsRow(ws.id, app.id), type: "ssl", auto: true, target: h, target_host: h, interval_sec: 21600 };
      }),
    ]);
    // 49 counted + 3 automatic: the 50th counted monitor is still allowed.
    const host = `itest-${hex(4)}.example.com`;
    expectOk(await db.rpc("create_monitor", httpMonitor(ws.id, app.id, host, L)));
    // It brought its host's SSL monitor with it, and that one isn't counted either.
    expect(await countOf(ws.id, (q) => q.eq("auto", true))).toBe(4);
    expectRefused(await db.rpc("create_monitor", dnsMonitor(ws.id, app.id, L)), raised("monitor_limit"));
  });

  // ── one automatic SSL monitor per HTTPS host ────────────────────────────────

  it("one automatic SSL monitor per HTTPS host: a second HTTPS monitor on the host adds none, and a direct second insert is refused", async () => {
    const { ws, app } = await fresh();
    const host = `itest-${hex(4)}.example.com`;
    await fx.monitor(httpMonitor(ws.id, app.id, host));
    await fx.monitor(httpMonitor(ws.id, app.id, host));
    const ssl = await db.from("monitors").select("type, auto, target, target_host, interval_sec").eq("workspace_id", ws.id).eq("type", "ssl");
    expect(ssl.data).toEqual([{ type: "ssl", auto: true, target: host, target_host: host, interval_sec: 21600 }]);
    expectRefused(
      await db
        .from("monitors")
        .insert({ ...dnsRow(ws.id, app.id), type: "ssl", auto: true, target: host, target_host: host, interval_sec: 21600 })
        .select("id"),
      uniqueViolation("monitors_one_auto_ssl_per_host"),
    );
  });

  it("adds no automatic SSL monitor for plain http, an IP address, a host with a port, or a host that already has an SSL monitor", async () => {
    const { ws, app } = await fresh();
    const plain = `itest-${hex(4)}.example.com`;
    await fx.monitor(httpMonitor(ws.id, app.id, plain, limits.free, { p_target: `http://${plain}/` }));
    await fx.monitor(httpMonitor(ws.id, app.id, "93.184.216.34", limits.free, { p_target: "https://93.184.216.34/" }));
    const ported = `itest-${hex(4)}.example.com`;
    await fx.monitor(httpMonitor(ws.id, app.id, ported, limits.free, { p_target: `https://${ported}:8443/` }));
    const manual = `itest-${hex(4)}.example.com`;
    await fx.monitor(httpMonitor(ws.id, app.id, manual, limits.free, { p_type: "ssl", p_target: manual, p_interval_sec: 21600 }));
    await fx.monitor(httpMonitor(ws.id, app.id, manual));
    const ssl = await db.from("monitors").select("auto, target_host").eq("workspace_id", ws.id).eq("type", "ssl");
    expect(ssl.data).toEqual([{ auto: false, target_host: manual }]);
  });

  it("SSL checks run every 6 hours and DNS checks at most every 10 minutes, on every plan", async () => {
    const { ws, app } = await fresh();
    const host = `itest-${hex(4)}.example.com`;
    const ssl = (interval: number) => httpMonitor(ws.id, app.id, host, limits.builder, { p_type: "ssl", p_target: host, p_interval_sec: interval });
    expectRefused(await db.rpc("create_monitor", ssl(21599)), raised("interval_not_allowed"));
    expectOk(await db.rpc("create_monitor", ssl(21600)));
    expectRefused(await db.rpc("create_monitor", dnsMonitor(ws.id, app.id, limits.builder, { p_interval_sec: 599 })), raised("interval_not_allowed"));
    expectOk(await db.rpc("create_monitor", dnsMonitor(ws.id, app.id, limits.builder, { p_interval_sec: 600 })));
  });

  // ── a missing limit is refused ──────────────────────────────────────────────

  it("create_monitor refuses each missing limit rather than reading it as none", async () => {
    const { ws, app } = await fresh();
    const keys = Object.keys(monitorLimitArgs(limits.free)) as (keyof ReturnType<typeof monitorLimitArgs>)[];
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      expectRefused(await db.rpc("create_monitor", { ...dnsMonitor(ws.id, app.id), [key]: null }), LIMITS_REQUIRED);
    }
    expect(await countOf(ws.id)).toBe(0);
  });

  it("create_status_page refuses a missing page limit", async () => {
    const { ws, app } = await fresh();
    expectRefused(
      await db.rpc("create_status_page", { p_workspace_id: ws.id, p_app_id: app.id, p_slug: testSlug(), p_name: "itest", p_logo_text: "", p_homepage: null, p_max_pages: null }),
      LIMITS_REQUIRED,
    );
  });

  it("save_status_page refuses a missing feature answer, and the two Builder switches without their features", async () => {
    const { ws, app } = await fresh();
    const page = await fx.page(ws.id, app.id);
    expectRefused(await db.rpc("save_status_page", savePageArgs(page as never, [], { p_white_label: null })), LIMITS_REQUIRED);
    expectRefused(await db.rpc("save_status_page", savePageArgs(page as never, [], { p_private_pages: null })), LIMITS_REQUIRED);
    expectRefused(await db.rpc("save_status_page", savePageArgs(page as never, [], { p_powered_by: false })), raised("white_label_required"));
    expectRefused(await db.rpc("save_status_page", savePageArgs(page as never, [], { p_noindex: true })), raised("private_pages_required"));
    const saved = expectOk(await db.rpc("save_status_page", savePageArgs(page as never, [], { p_powered_by: false, p_noindex: true, p_white_label: true, p_private_pages: true })));
    expect({ powered_by: saved.powered_by, noindex: saved.noindex }).toEqual({ powered_by: false, noindex: true });
  });

  it("save_status_page takes 50 components and refuses 51", async () => {
    const { ws, app } = await fresh();
    const page = await fx.page(ws.id, app.id);
    const components = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, monitorIds: [] }));
    expectOk(await db.rpc("save_status_page", savePageArgs(page as never, components(50))));
    expectRefused(await db.rpc("save_status_page", savePageArgs(page as never, components(51))), raised("components_invalid"));
    const count = await db.from("page_components").select("id", { count: "exact", head: true }).eq("page_id", page.id);
    expect(count.count).toBe(50);
  });

  it("refuses the monitor types that aren't available yet", async () => {
    const { ws, app } = await fresh();
    for (const type of ["stripe", "mcp", "supabase"]) {
      expectRefused(await db.rpc("create_monitor", dnsMonitor(ws.id, app.id, limits.builder, { p_type: type })), raised("type_not_available"));
    }
  });

  // ── races at the boundary ───────────────────────────────────────────────────

  it("race: eight concurrent creates of the last monitor allowed, exactly one succeeds", async () => {
    const L = limits.free;
    const { ws, app } = await fresh();
    await fx.seedMonitors(Array.from({ length: L.monitors - 1 }, () => dnsRow(ws.id, app.id)));
    const results = await Promise.all(Array.from({ length: 8 }, () => db.rpc("create_monitor", dnsMonitor(ws.id, app.id, L))));
    const outcomes = results.map((r) => refusalOf(r)).map((r) => (r.status === 200 ? "created" : `${r.status} ${r.code} ${r.message}`));
    expect(outcomes.sort()).toEqual(["400 P0001 monitor_limit", "400 P0001 monitor_limit", "400 P0001 monitor_limit", "400 P0001 monitor_limit", "400 P0001 monitor_limit", "400 P0001 monitor_limit", "400 P0001 monitor_limit", "created"]);
    expect(await countOf(ws.id)).toBe(L.monitors);
  });

  it("race: five concurrent creates of the last heartbeat allowed, exactly one succeeds", async () => {
    const L = limits.free;
    const { ws, app } = await fresh();
    await fx.seedMonitors(Array.from({ length: L.heartbeats - 1 }, () => ({ ...dnsRow(ws.id, app.id), type: "heartbeat", interval_sec: 3600, heartbeat_token_hash: testTokenHash() })));
    const results = await Promise.all(Array.from({ length: 5 }, () => db.rpc("create_monitor", heartbeatMonitor(ws.id, app.id, L))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).map((r) => refusalOf(r))).toEqual(Array.from({ length: 4 }, () => raised("heartbeat_limit")));
    expect(await countOf(ws.id, (q) => q.eq("type", "heartbeat"))).toBe(L.heartbeats);
  });

  it("race: two concurrent creates of the free plan's only status page, on two apps, exactly one succeeds", async () => {
    const ws = await fx.workspace();
    const apps = [await fx.app(ws.id), await fx.app(ws.id)];
    const results = await Promise.all(
      apps.map((a) =>
        db.rpc("create_status_page", { p_workspace_id: ws.id, p_app_id: a.id, p_slug: testSlug(), p_name: "itest", p_logo_text: "", p_homepage: null, p_max_pages: limits.free.statusPages }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).map((r) => refusalOf(r))).toEqual([raised("page_limit")]);
  });
});
