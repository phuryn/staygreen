import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/authz";
import { FREE, type Entitlements } from "@/lib/plans";
import { clientFor, describeTarget, Fixtures, hex, readTarget, testUserId } from "../support/integration";

/* Cross-tenant through the Alerts screen's own Server Actions and its read, on the real database
   (`docs/permissions.md`, `docs/flows.md § Alerts`), as `actions.test.ts` does for the rest of the
   dashboard: identity is a mock verifier behind the same seam as Clerk.

   Faked here and nowhere else: the caller, the request headers a same-origin browser sends, and
   every provider. Postmark's send, the sender's one-event run, Clerk's member list and Telegram's
   `getMe` are stubs, so nothing this file does can reach an inbox or a chat, whatever `.env`
   holds. Everything the actions write goes to the development database, which needs migration
   023 (`docs/environments.md § Alerts`). */

vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return { ...actual, headers: async () => new Headers({ "sec-fetch-site": "same-origin", host: "localhost" }) };
});
vi.mock("@/lib/alerts/postmark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alerts/postmark")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ kind: "sent", messageId: "itest-not-sent", redirected: true })), findSent: vi.fn(async () => ({ kind: "none" })) };
});
vi.mock("@/lib/alerts/clerk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alerts/clerk")>();
  return { ...actual, membersOf: vi.fn(async () => []) };
});
vi.mock("@/lib/alerts/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alerts/telegram")>();
  return { ...actual, botUsername: vi.fn(async () => "staygreen_itest_bot"), sendTelegram: vi.fn(async () => ({ kind: "sent", messageId: "1", redirected: false })) };
});
vi.mock("@/lib/alerts/standalone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alerts/standalone")>();
  return {
    ...actual,
    postmarkConfig: () => ({ token: "00000000-0000-0000-0000-000000000000", from: "Staygreen alerts <alerts@staygreen.io>", redirectTo: "test@blackhole.postmarkapp.com" }),
    telegramConfig: () => ({ token: "000000:itest" }),
  };
});
vi.mock("@/lib/alerts/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alerts/server")>();
  const report = { expanded: 0, sent: 0, failed: 0, skipped: 0, retrying: 0, reconciled: 0, inDoubt: 0, released: 0, messageIds: [], failures: [] };
  return { ...actual, emailReady: () => true, telegramReady: () => true, deliverNow: vi.fn(async () => report) };
});

const target = readTarget();

const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." };

/** Builder's teammates feature, so adding an address gets past the plan to the id checks. */
const TEAMMATES: Entitlements = { ...FREE, features: ["notify_teammates"] };

describeTarget("alert actions: a member of A, with B's ids, is refused by every action and never reads B", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  let actions: typeof import("@/app/(app)/app/alerts/actions");
  let server: typeof import("@/lib/alerts/server");

  let caller: Caller | null = null;
  let A: { id: string; clerk_org_id: string }, B: { id: string; clerk_org_id: string };
  let callerA: Caller, callerB: Caller;
  const a: Record<string, string> = {};
  const b: Record<string, string> = {};

  const as = async <T>(who: Caller | null, run: () => Promise<T>): Promise<T> => {
    caller = who;
    try {
      return await run();
    } finally {
      caller = null;
    }
  };

  const one = async <T>(q: PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>, what: string): Promise<T> => {
    const r = await q;
    if (r.error || r.data === null) throw new Error(`fixture ${what} failed: ${r.error?.code} ${r.error?.message}`);
    return r.data;
  };

  const membersChannel = async (workspaceId: string) =>
    (await one(db.from("alert_channels").select("id").eq("workspace_id", workspaceId).eq("audience", "members").single(), "members channel")) as { id: string };

  beforeAll(async () => {
    const session = await import("@/lib/session");
    actions = await import("@/app/(app)/app/alerts/actions");
    server = await import("@/lib/alerts/server");
    session.setSessionVerifier({ current: async () => caller, entitlements: async () => TEAMMATES });

    A = await fx.workspace();
    B = await fx.workspace();
    callerA = { userId: testUserId(), orgId: A.clerk_org_id, orgRole: "org:admin" };
    callerB = { userId: testUserId(), orgId: B.clerk_org_id, orgRole: "org:admin" };

    a.app = (await fx.app(A.id)).id;
    a.members = (await membersChannel(A.id)).id;
    b.app = (await fx.app(B.id)).id;
    b.members = (await membersChannel(B.id)).id;

    // B's channels, written directly: an address waiting for its confirmation, a confirmed one,
    // and a bound Telegram chat. Nothing here is ever sent.
    const channel = (row: Record<string, unknown>, what: string) =>
      one(db.from("alert_channels").insert({ workspace_id: B.id, created_by: callerB.userId, ...row }).select("id").single(), what) as Promise<{ id: string }>;
    b.waiting = (await channel({ kind: "email", audience: "address", address: `itest-${hex(4)}@example.com`, confirm_hash: hex(32), confirm_sent_at: new Date().toISOString() }, "waiting address")).id;
    b.confirmed = (await channel({ kind: "email", audience: "address", address: `itest-${hex(4)}@example.com`, confirmed_at: new Date().toISOString() }, "confirmed address")).id;
    b.telegram = (await channel({ kind: "telegram", chat_id: 900_000_000_000 + Math.floor(Math.random() * 1e9), label: "itest chat", confirmed_at: new Date().toISOString() }, "telegram chat")).id;
    await one(db.from("alert_exclusions").insert({ channel_id: b.confirmed, app_id: b.app, workspace_id: B.id }).select("channel_id").single(), "exclusion");
    await one(db.from("alert_suppressions").insert({ channel_id: b.members, workspace_id: B.id, recipient: callerB.userId }).select("channel_id").single(), "suppression");
    const ev = (await one(
      db.from("alert_events").insert({ workspace_id: B.id, kind: "test", channel_id: b.confirmed, requested_by: callerB.userId, expanded_at: new Date().toISOString() }).select("id").single(),
      "event",
    )) as { id: string };
    b.event = ev.id;
    b.delivery = (
      (await one(
        db.from("alert_deliveries").insert({ workspace_id: B.id, event_id: ev.id, event: "test", channel_id: b.confirmed, recipient: "channel", status: "failed", detail: "itest" }).select("id").single(),
        "delivery",
      )) as { id: string }
    ).id;

    // A has an address of its own, so its own writes have something to act on.
    a.address = (await one(
      db.from("alert_channels").insert({ workspace_id: A.id, kind: "email", audience: "address", address: `itest-${hex(4)}@example.com`, confirmed_at: new Date().toISOString(), created_by: callerA.userId }).select("id").single(),
      "A's address",
    ) as { id: string }).id;
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  /** Every alert row B owns, for the before-and-after comparison. */
  async function rowsOfB() {
    const out: Record<string, unknown[]> = {};
    for (const table of ["alert_channels", "alert_exclusions", "alert_suppressions", "alert_events", "alert_deliveries"]) {
      const res = await db.from(table).select("*").eq("workspace_id", B.id);
      if (res.error) throw new Error(`${table}: ${res.error.code}`);
      out[table] = [...(res.data ?? [])].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    }
    return out;
  }

  const everyWriteOn = async (who: Caller | null) =>
    as(who, async () => ({
      resendWaiting: await actions.resendAlertConfirmation(b.waiting),
      removeAddress: await actions.removeAlertChannel(b.confirmed),
      removeMembers: await actions.removeAlertChannel(b.members),
      removeChat: await actions.removeAlertChannel(b.telegram),
      routeOff: await actions.setAlertRoute(b.confirmed, b.app, false),
      routeOn: await actions.setAlertRoute(b.confirmed, b.app, true),
      routeViaOwnApp: await actions.setAlertRoute(b.confirmed, a.app, false),
      routeOwnChannelToTheirApp: await actions.setAlertRoute(a.address, b.app, false),
      explicitRouteTheirApp: await actions.saveAlertRouting({ appId: b.app, monitorId: null, severity: "all", channelIds: [a.address] }),
      explicitRouteTheirChannel: await actions.saveAlertRouting({ appId: a.app, monitorId: null, severity: "all", channelIds: [b.confirmed] }),
      testAddress: await actions.sendTestAlert(b.confirmed),
      testMembers: await actions.sendTestAlert(b.members),
      testChat: await actions.sendTestAlert(b.telegram),
    }));

  it("built B's alert fixtures", () => {
    for (const k of ["members", "waiting", "confirmed", "telegram"]) expect(b[k], k).toMatch(/^chan_[0-9a-f]{24}$/);
    expect(b.delivery).toMatch(/^dlv_[0-9a-f]{24}$/);
  });

  it("refuses every alert write on B's ids with the same not-found, and leaves B's rows exactly as they were", async () => {
    const before = await rowsOfB();
    const results = await everyWriteOn(callerA);
    for (const [k, v] of Object.entries(results)) expect(v, k).toEqual(NOT_FOUND);
    expect(await rowsOfB()).toEqual(before);
  });

  it("answers a Telegram link of B's exactly as it answers one that doesn't exist", async () => {
    const theirs = await as(callerA, () => actions.telegramLinkState(b.telegram));
    const missing = await as(callerA, () => actions.telegramLinkState(`chan_${hex(12)}`));
    expect(theirs).toEqual(missing);
    expect(JSON.stringify(theirs)).not.toContain("itest chat");
  });

  it("refuses a role that holds nothing, and a signed-out caller, before anything is read", async () => {
    const before = await rowsOfB();
    for (const who of [{ ...callerB, orgRole: "org:member" }, null] as (Caller | null)[]) {
      const writes = await everyWriteOn(who);
      const rest = await as(who, async () => ({
        addAddress: await actions.addAlertAddress({ address: `itest-${hex(4)}@example.com` }),
        myEmail: await actions.setMyAlertEmail(false),
        connect: await actions.connectTelegram(),
        linkState: await actions.telegramLinkState(b.telegram),
      }));
      const results = { ...writes, ...rest };
      for (const [k, v] of Object.entries(results)) expect((v as { ok: boolean }).ok, `${who?.orgRole ?? "signed out"}: ${k}`).toBe(false);
    }
    expect(await rowsOfB()).toEqual(before);
  });

  it("turns a member's own email off and on in their own workspace, and touches nobody else's", async () => {
    const before = await rowsOfB();
    const off = await as(callerA, () => actions.setMyAlertEmail(false));
    expect(off).toEqual({ ok: true });
    const rows = await db.from("alert_suppressions").select("channel_id, recipient").eq("workspace_id", A.id);
    expect(rows.data).toEqual([{ channel_id: a.members, recipient: callerA.userId }]);
    expect(await as(callerA, () => actions.setMyAlertEmail(true))).toEqual({ ok: true });
    expect((await db.from("alert_suppressions").select("recipient").eq("workspace_id", A.id)).data).toEqual([]);
    expect(await rowsOfB()).toEqual(before);
  });

  it("acts on A's own channels: an app switched off and on, a test queued, the members' channel kept", async () => {
    expect(await as(callerA, () => actions.setAlertRoute(a.address, a.app, false))).toEqual({ ok: true });
    expect((await db.from("alert_exclusions").select("app_id").eq("channel_id", a.address)).data).toEqual([{ app_id: a.app }]);
    expect(await as(callerA, () => actions.setAlertRoute(a.address, a.app, true))).toEqual({ ok: true });
    expect((await db.from("alert_exclusions").select("app_id").eq("channel_id", a.address)).data).toEqual([]);

    const test = await as(callerA, () => actions.sendTestAlert(a.address));
    expect(test.ok).toBe(true);
    const events = await db.from("alert_events").select("kind, channel_id, requested_by").eq("workspace_id", A.id);
    expect(events.data).toEqual([{ kind: "test", channel_id: a.address, requested_by: callerA.userId }]);

    const kept = await as(callerA, () => actions.removeAlertChannel(a.members));
    expect(kept).toEqual({ ok: false, reason: "Members always get alerts. Each member can turn their own email off." });
  });

  it("stores an added address unconfirmed, in A's own workspace, with only its confirmation's hash", async () => {
    const added = await as(callerA, () => actions.addAlertAddress({ address: `itest-${hex(4)}@example.com` }));
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const row = (await one(db.from("alert_channels").select("workspace_id, confirmed_at, confirm_hash").eq("id", added.id).single(), "added row")) as unknown as {
      workspace_id: string;
      confirmed_at: string | null;
      confirm_hash: string;
    };
    expect(row).toMatchObject({ workspace_id: A.id, confirmed_at: null });
    expect(row.confirm_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loadAlertsView for A carries A's channels and receipts and none of B's", async () => {
    const view = await server.loadAlertsView({ caller: callerA, workspace: A, entitlements: TEAMMATES });
    const text = JSON.stringify(view);
    for (const [k, v] of Object.entries(b)) expect(text, `B's ${k}`).not.toContain(v);
    expect(text).not.toContain(B.id);
    expect(text).not.toContain("itest chat");
    expect(view.channels.map((c) => c.id)).toContain(a.members);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });
});
