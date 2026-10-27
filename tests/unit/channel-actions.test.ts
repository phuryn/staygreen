import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE } from "@/lib/plans";
import { open } from "@/lib/seal";
import { channelContext } from "@/lib/alerts/channel-input";
import { hashConfirmToken } from "@/lib/alerts/links";
import { addWebhookChannel, connectSlack, saveAlertRouting, removeAlertChannel, sendTestAlert } from "@/app/(app)/app/alerts/actions";
import { GET } from "@/app/api/slack/callback/route";

const fake = vi.hoisted(() => ({ member: vi.fn(), origin: vi.fn(), rpc: vi.fn(), insert: vi.fn(), select: vi.fn(), target: vi.fn(), exchange: vi.fn(), eq: vi.fn(), or: vi.fn(), config: { APP_URL: "https://staygreen.test", CREDENTIALS_KEY: "", SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/workspace", async (original) => ({ ...await original<typeof import("@/lib/workspace")>(), memberOrNull: fake.member }));
vi.mock("@/lib/request", async (original) => ({ ...await original<typeof import("@/lib/request")>(), assertSameOrigin: fake.origin }));
vi.mock("@/lib/env", () => ({ env: () => fake.config }));
vi.mock("@/lib/targets", () => ({ checkTarget: fake.target }));
vi.mock("@/lib/alerts/slack", async (original) => ({ ...await original<typeof import("@/lib/alerts/slack")>(), exchangeSlack: fake.exchange }));
vi.mock("@/lib/db", () => ({ db: () => {
  const chain: Record<string, unknown> = {};
  chain.eq = (...args: unknown[]) => { fake.eq(...args); return chain; };
  chain.select = () => chain;
  chain.single = async () => ({ data: { id: "aev_test" }, error: null });
  chain.maybeSingle = fake.select;
  chain.lt = async () => ({ error: null });
  chain.or = fake.or;
  return { rpc: fake.rpc, from: () => ({ select: () => chain, delete: () => chain, insert: (v: unknown) => { fake.insert(v); return { ...chain, then: (f: (r: unknown) => unknown) => Promise.resolve({ error: null }).then(f) }; } }) };
} }));
const key = Buffer.alloc(32, 5);
const ws = { id: "ws_a", clerk_org_id: "org_a" };
const admin = { caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, workspace: ws, entitlements: FREE };
const app = `app_${"a".repeat(24)}`, channel = `chan_${"b".repeat(24)}`;
beforeEach(() => {
  vi.clearAllMocks(); fake.member.mockResolvedValue(admin); fake.origin.mockResolvedValue(undefined); fake.target.mockResolvedValue({ ok: true });
  fake.rpc.mockImplementation(async (fn) => ({ data: fn === "spend_budget" ? { ok: true } : true, error: null }));
  fake.config.CREDENTIALS_KEY = key.toString("base64url"); fake.config.SLACK_CLIENT_ID = "123.456";
  fake.exchange.mockResolvedValue({ token: "xoxb-test-123", channel: "C123", label: "#alerts" });
  fake.select.mockResolvedValue({ data: { id: channel, kind: "discord", audience: null, confirmed_at: "2026-10-23", unsubscribed_at: null }, error: null });
  fake.or.mockResolvedValue({ error: null });
});
describe("new channel actions and Slack callback", () => {
  it("refuses exhausted setup budgets before DNS, saving or starting OAuth", async () => {
    fake.rpc.mockResolvedValue({ data: { ok: false, scope: "member", retryAfterSec: 120 }, error: null });
    expect(await connectSlack()).toMatchObject({ ok: false, retryAfterSec: 120, reason: expect.stringContaining("channel setup") });
    for (const kind of ["discord", "webhook"]) {
      const url = kind === "discord" ? `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(60)}` : "https://receiver.example.com";
      expect(await addWebhookChannel({ kind, label: "Ops", url, secret: "a".repeat(40) })).toMatchObject({ ok: false, retryAfterSec: 120 });
    }
    expect(fake.target).not.toHaveBeenCalled(); expect(fake.insert).not.toHaveBeenCalled();
  });
  it("stores only the sealed URL and signing secret and returns just its id", async () => {
    const input = { kind: "webhook", label: "Ops", url: "https://receiver.example.com/?key=secret", secret: "A".repeat(40) };
    const r = await addWebhookChannel(input); expect(r).toMatchObject({ ok: true, id: expect.stringMatching(/^chan_/) });
    const row = fake.insert.mock.calls[0][0];
    expect(JSON.stringify(row)).not.toMatch(/receiver.example.com|key=secret|A{40}/);
    expect(JSON.parse(open(row.sealed, channelContext(ws.id, row.id), key))).toEqual({ url: input.url, secret: input.secret });
    expect(JSON.stringify(r)).not.toContain("sealed");
  });
  it("refuses private DNS, missing permission, a missing session and cross-origin writes", async () => {
    const input = { kind: "webhook", label: "Ops", url: "https://receiver.example.com", secret: "A".repeat(40) };
    fake.target.mockResolvedValue({ ok: false }); expect(await addWebhookChannel(input)).toMatchObject({ ok: false });
    fake.member.mockResolvedValue({ ...admin, caller: { ...admin.caller, orgRole: "org:member" } });
    expect(await addWebhookChannel(input)).toMatchObject({ ok: false }); expect(await connectSlack()).toMatchObject({ ok: false });
    fake.member.mockResolvedValue(null); expect(await saveAlertRouting({ appId: app, monitorId: null, severity: "all", channelIds: [] })).toMatchObject({ ok: false });
    const { CrossOrigin } = await import("@/lib/request"); fake.origin.mockRejectedValue(new CrossOrigin());
    expect(await addWebhookChannel(input)).toMatchObject({ ok: false, reason: expect.stringContaining("refused") }); expect(fake.insert).not.toHaveBeenCalled();
  });
  it("gates severity by verified entitlement and binds routing writes to the caller's workspace", async () => {
    const input = { appId: app, monitorId: null, severity: "warning", channelIds: [channel] };
    expect(await saveAlertRouting(input)).toMatchObject({ ok: false, reason: expect.stringContaining("Builder") }); expect(fake.rpc).not.toHaveBeenCalled();
    expect(await saveAlertRouting({ ...input, severity: "all" })).toEqual({ ok: true });
    expect(fake.rpc).toHaveBeenCalledWith("set_alert_routing", expect.objectContaining({ p_workspace_id: ws.id, p_alert_rules: false }));
    fake.rpc.mockResolvedValue({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await saveAlertRouting({ ...input, severity: "all" })).toMatchObject({ ok: false, reason: "That isn't here any more. Reload the page." });
  });
  it("removes a channel with null audience and queues its test without sending from Next", async () => {
    expect(await removeAlertChannel(channel)).toEqual({ ok: true });
    expect(fake.or).toHaveBeenCalledWith("audience.is.null,audience.neq.members");
    expect(await sendTestAlert(channel)).toMatchObject({ ok: true, sent: false, detail: expect.stringContaining("queued") });
    expect(fake.eq).toHaveBeenCalledWith("workspace_id", ws.id);
  });
  it("keeps Slack off without configuration and stores only a hash when starting", async () => {
    fake.config.SLACK_CLIENT_ID = ""; expect(await connectSlack()).toMatchObject({ ok: false }); expect(fake.insert).not.toHaveBeenCalled();
    fake.config.SLACK_CLIENT_ID = "123.456"; const r = await connectSlack();
    if (!r.ok) throw Error("start failed"); const state = new URL(r.url).searchParams.get("state")!;
    expect(fake.insert).toHaveBeenCalledWith({ state_hash: hashConfirmToken(state), workspace_id: ws.id, user_id: admin.caller.userId });
    expect(JSON.stringify(fake.insert.mock.calls)).not.toContain(state);
  });
  it("refuses absent, expired, replayed and foreign state before OAuth; never reflects query secrets", async () => {
    const req = (query: string) => new Request(`https://staygreen.test/api/slack/callback?${query}`);
    const state = "a".repeat(43);
    await GET(req("code=secret")); expect(fake.rpc).not.toHaveBeenCalled();
    fake.rpc.mockResolvedValue({ data: false, error: null });
    const r = await GET(req(`code=secret&state=${state}`));
    expect(fake.rpc).toHaveBeenCalledWith("consume_slack_install", { p_hash: hashConfirmToken(state), p_workspace_id: ws.id, p_user_id: admin.caller.userId });
    expect(fake.exchange).not.toHaveBeenCalled(); expect(r.headers.get("location")).toBe("https://staygreen.test/app/alerts?slack=failed");
    expect(r.headers.get("cache-control")).toBe("no-store"); expect(await r.text()).not.toContain("secret");
  });
  it("saves Slack only after one-use state consumption and seals its bot token", async () => {
    const r = await GET(new Request(`https://staygreen.test/api/slack/callback?code=code&state=${"a".repeat(43)}`));
    expect(r.headers.get("location")).toContain("slack=connected");
    const row = fake.insert.mock.calls[0][0]; expect(row.kind).toBe("slack");
    expect(JSON.parse(open(row.sealed, channelContext(ws.id, row.id), key))).toEqual({ token: "xoxb-test-123", channel: "C123" });
  });
});
