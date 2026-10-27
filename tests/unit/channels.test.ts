import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { connect } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { channelContext, channelInput, discordUrl, webhookUrl } from "../../src/lib/alerts/channel-input";
import { sendDiscord, sendSlack } from "../../src/lib/alerts/providers";
import { exchangeSlack, slackAuthorize } from "../../src/lib/alerts/slack";
import { pinnedWebhookTransport, signature, webhookPayload } from "../../src/lib/alerts/webhook";
import { messageFor, runSender, type Claimed, type SenderDeps } from "../../src/lib/alerts/sender";
import { seal } from "../../src/lib/seal";
import { serverEnvSchema } from "../../src/lib/env-schema";
import { composeOpened, maskAlertText } from "../../src/lib/alerts/compose";

const message = { subject: "App: API down", lines: ["GET /health returned 503", "Toronto and San Francisco", "Incident inc_1", "https://status.test"] };
const discord = `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(60)}`;
const now = Date.UTC(2026, 9, 23);
const key = randomBytes(32);
function receipt(kind: string, overrides: Partial<Claimed> = {}): Claimed {
  return { id: "dlv_test", event: "opened", eventId: "aev_test", attempts: 1, inDoubt: false, recipient: "channel", workspaceId: "ws_a", clerkOrgId: "org_a", createdAt: now,
    channel: { id: "chan_a", kind, audience: null, address: null, chatId: null,
      sealed: seal(JSON.stringify({ token: "xoxb-123456789-test", channel: "C1234", url: kind === "discord" ? discord : "https://receiver.example.com/hook", secret: "a".repeat(40) }), channelContext("ws_a", "chan_a"), key) },
    why: null, stateAfter: null,
    incident: { id: "inc_a", title: "API down", severity: "down", openedAt: now, resolvedAt: null,
      evidence: { request: "GET /health?token=abc", status: 200, assertion: "$.db == true", got: false, locations: ["tor1", "sfo3", "internal"], snippet: '{"token":"secret-value"}' } },
    monitor: { id: "mon_a", name: "API", type: "http" }, app: { id: "app_a", name: "App" }, pageSlug: "app", ...overrides };
}
function rig(d: Claimed, response: Response | Error = Response.json({ ok: true, ts: "123.456" })) {
  let claimed = false;
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    if (fn === "alert_pending_events") return [];
    if (fn === "alert_claim_channels") {
      if (claimed) return []; claimed = true;
      return [{ ...d, createdAt: new Date(d.createdAt).toISOString(), webhookStartedAt: d.webhookStartedAt ? new Date(d.webhookStartedAt).toISOString() : null,
        incident: d.incident && { ...d.incident, openedAt: new Date(d.incident.openedAt).toISOString(), resolvedAt: d.incident.resolvedAt ? new Date(d.incident.resolvedAt).toISOString() : null } }];
    }
    if (fn === "alert_prepare_webhook") return { body: d.webhookBody ?? args.p_body, startedAt: new Date(d.webhookStartedAt ?? now).toISOString(), attempts: (d.webhookAttempts ?? 0) + 1 };
    if (fn === "alert_mark") return true;
    throw Error(fn);
  });
  const fetch = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
  const webhook = vi.fn(async () => ({ kind: "retry" as const, detail: "No answer." }));
  const deps: SenderDeps = { rpc, appUrl: "https://staygreen.test", postmark: null, telegram: null, linkSecret: null, members: async () => [], now: () => now,
    channels: { key, fetch, webhook } };
  return { rpc, fetch, webhook, run: () => runSender(deps), mark: () => rpc.mock.calls.filter(([fn]) => fn === "alert_mark").map(([, a]) => a) };
}

describe("channel credential validation", () => {
  it.each(["http://example.com", "https://127.1", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://10.0.0.1", "https://169.254.169.254", "https://100.64.0.1", "https://localhost", "https://x.local", "https://example.com:25", "https://u:p@example.com", "https://example.com/#secret"])("refuses %s", (u) => expect(webhookUrl(u)).toBeNull());
  it("allows only the provider's exact webhook path and host", () => {
    expect(discordUrl(discord)?.host).toBe("discord.com");
    for (const u of [discord + "?thread_id=1", discord.replace("discord.com", "discord.com.evil.test"), discord.replace("/webhooks/", "/channels/")]) expect(discordUrl(u)).toBeNull();
    expect(channelInput.safeParse({ kind: "webhook", label: "Ops", url: "https://example.com", secret: "short" }).success).toBe(false);
  });
  it("keeps Slack configuration optional as a pair and rejects a partial pair", () => {
    expect(serverEnvSchema.shape.SLACK_CLIENT_ID.safeParse("123.456").success).toBe(true);
    expect(serverEnvSchema.shape.SLACK_CLIENT_ID.safeParse("secret").success).toBe(false);
    expect(serverEnvSchema.shape.SLACK_CLIENT_SECRET.safeParse("a".repeat(32)).success).toBe(true);
  });
});

describe("Slack and Discord", () => {
  it("asks Slack for its channel picker and chat:write from the first install", async () => {
    const u = new URL(slackAuthorize("123.456", "https://staygreen.test", "state"));
    expect(u.searchParams.get("scope")).toBe("incoming-webhook,chat:write");
    expect(u.searchParams.get("redirect_uri")).toBe("https://staygreen.test/api/slack/callback");
    const data = { ok: true, scope: "incoming-webhook,chat:write", access_token: "xoxb-123-test", incoming_webhook: { channel_id: "C123", channel: "#alerts", url: "discard-me" } };
    expect(await exchangeSlack("id", "secret", "https://staygreen.test", "code", vi.fn(async () => Response.json(data)))).toEqual({ token: data.access_token, channel: "C123", label: "#alerts" });
    expect(await exchangeSlack("id", "secret", "https://staygreen.test", "code", vi.fn(async () => Response.json({ ...data, scope: "incoming-webhook" })))).toBeNull();
  });
  it("posts a recovery as a thread reply, with mentions and unfurling disabled", async () => {
    const send = vi.fn(async () => Response.json({ ok: true, ts: "123.45" }));
    expect(await sendSlack("token", "C123", { ...message, subject: "<!channel> <@U123>" }, "123.44", send)).toMatchObject({ kind: "sent", messageId: "123.45" });
    const init = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init[1].body))).toMatchObject({ thread_ts: "123.44", channel: "C123", mrkdwn: false, parse: "none", unfurl_links: false, text: expect.stringContaining("&lt;!channel&gt;") });
    expect(init[1].redirect).toBe("manual");
  });
  it("waits for Discord's message id and suppresses mentions", async () => {
    const send = vi.fn(async () => Response.json({ id: "123456789" }));
    expect(await sendDiscord(discord, message, send)).toMatchObject({ kind: "sent", messageId: "123456789" });
    const call = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].search).toBe("?wait=true");
    expect(JSON.parse(String(call[1].body))).toMatchObject({ allowed_mentions: { parse: [] }, embeds: [{ description: expect.stringContaining("https://status.test") }] });
  });
  it("keeps both incident links when long evidence exceeds Discord's embed limit", async () => {
    const send = vi.fn(async () => Response.json({ id: "123456789" }));
    const incident = "Incident inc_1: https://staygreen.test/app/incidents/inc_1";
    const status = "Status page: https://staygreen.test/s/app";
    await sendDiscord(discord, { ...message, lines: ["Evidence ".repeat(1000), "", incident, status] }, send);
    const call = send.mock.calls[0] as unknown as [URL, RequestInit];
    const description = JSON.parse(String(call[1].body)).embeds[0].description;
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain(incident); expect(description).toContain(status);
  });
  it.each([false, 0, null])("keeps assertion result %s in chat evidence", (got) => {
    const d = receipt("slack"); d.incident!.evidence.got = got;
    expect(messageFor(d, "https://staygreen.test", null, now)?.lines[0]).toContain(`got ${got}`);
  });
  it.each([sendSlack, sendDiscord])("classifies ambiguous acceptance without retrying", async (provider) => {
    const drop = vi.fn(async () => { throw new Error("token-do-not-echo"); });
    const r = provider === sendSlack ? await sendSlack("t", "C123", message, null, drop) : await sendDiscord(discord, message, drop);
    expect(r.kind).toBe("unknown"); expect(JSON.stringify(r)).not.toContain("token-do-not-echo");
  });
  it("retries a definite 429 but treats Slack internal errors as unknown", async () => {
    expect(await sendSlack("t", "C123", message, null, vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "120" } })))).toMatchObject({ kind: "retry", retryAfterSec: 120 });
    expect(await sendSlack("t", "C123", message, null, vi.fn(async () => Response.json({ ok: false, error: "internal_error" })))).toMatchObject({ kind: "unknown" });
    expect(await sendDiscord(discord, message, vi.fn(async () => new Response(null, { status: 500 })))).toMatchObject({ kind: "unknown" });
  });
});

describe("sender receipt behavior", () => {
  it.each(["slack", "discord"])("never blindly resends an uncertain %s claim", async (kind) => {
    const r = rig(receipt(kind, { inDoubt: true }));
    await r.run(); expect(r.fetch).not.toHaveBeenCalled(); expect(r.mark()[0]).toMatchObject({ p_status: "failed", p_detail: expect.stringContaining("may have arrived") });
    const lost = rig(receipt(kind), new Error("response lost"));
    await lost.run(); expect(lost.fetch).toHaveBeenCalledTimes(1); expect(lost.mark()[0].p_status).toBe("failed");
  });
  it("requires a confirmed opening timestamp for a Slack recovery", async () => {
    const r = rig(receipt("slack", { event: "resolved" })); await r.run(); expect(r.fetch).not.toHaveBeenCalled(); expect(r.mark()[0].p_status).toBe("skipped");
    const threaded = rig(receipt("slack", { event: "resolved", parentProviderId: "123.4" })); await threaded.run();
    expect(JSON.parse(String((threaded.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).thread_ts).toBe("123.4");
  });
  it("refuses a sealed credential transplanted from another workspace", async () => {
    const r = rig(receipt("slack", { workspaceId: "ws_b" })); await r.run(); expect(r.fetch).not.toHaveBeenCalled(); expect(r.mark()[0].p_status).toBe("failed");
  });
  it("retries webhooks on the durable body at the specified offsets, then stops", async () => {
    for (const [attempts, minutes] of [[0, 1], [1, 3], [2, 7], [3, 15], [4, 30]]) {
      const r = rig(receipt("webhook", { webhookAttempts: attempts, webhookStartedAt: now, webhookBody: '{"id":"saved"}' }));
      await r.run(); expect(r.webhook).toHaveBeenCalledWith(expect.any(String), '{"id":"saved"}', expect.objectContaining({ "Idempotency-Key": "dlv_test" }));
      expect(r.mark()[0]).toMatchObject({ p_status: "pending", p_retry_sec: minutes * 60 });
    }
    const last = rig(receipt("webhook", { webhookAttempts: 5 })); await last.run(); expect(last.mark()[0].p_status).toBe("failed");
    const exhausted = rig(receipt("webhook", { webhookAttempts: 6, inDoubt: true })); await exhausted.run(); expect(exhausted.webhook).not.toHaveBeenCalled();
  });
});

describe("signed webhook and SSRF boundary", () => {
  it("redacts short/plain URL query credentials from every channel's evidence", () => {
    const request = "GET https://example.com/health?token=abc123&key=xyz";
    expect(maskAlertText("Cannot GET /health?token=abc123; got xyz", request)).not.toMatch(/abc123|xyz/);
    const m = composeOpened({ id: "inc_1", title: "API failed", severity: "down", openedAt: now, resolvedAt: null, evidence: { request, summary: "abc123 failed", snippet: "xyz", assertion: "$.key == abc123", got: "xyz" } }, { appName: "App", monitorName: "API", monitorType: "http", pageSlug: null }, { incidentUrl: "https://staygreen.test/inc_1", pageUrl: null });
    expect(JSON.stringify(m)).not.toMatch(/abc123|xyz/);
    const d = receipt("webhook"); d.incident!.evidence = { request, snippet: "abc123 xyz", got: "xyz" };
    expect(webhookPayload(d, "https://staygreen.test")).not.toMatch(/abc123|xyz/);
    d.incident!.evidence = { request: "GET /health?key=123", got: 123 };
    expect(JSON.parse(webhookPayload(d, "https://staygreen.test")).evidence.got).toBe("•••");
    expect(maskAlertText("a%2Fb a\\/b", "GET /health?key=a%2Fb")).toBe("••• •••");
  });
  it("signs the exact raw body and timestamp; payload is masked and allowlisted", () => {
    const body = webhookPayload(receipt("webhook"), "https://staygreen.test");
    const p = JSON.parse(body);
    expect(p).toMatchObject({ id: "dlv_test", event: "incident.opened", evidence: { status: 200, got: false, locations: ["tor1", "sfo3"] } });
    expect(body).not.toMatch(/secret-value|token=abc|sealed|xoxb/);
    expect(signature("secret", 100, body)).toBe(`t=100,v1=${createHmac("sha256", "secret").update(`100.${body}`).digest("hex")}`);
  });
  it("keeps escaped legacy evidence within the durable body limit", () => {
    const d = receipt("webhook"), long = "\u0000🎋".repeat(4000);
    d.incident!.evidence = { summary: long, assertion: long, snippet: long, got: long, request: `GET https://example.com/${long}` };
    d.app!.name = long; d.monitor!.name = long;
    const body = webhookPayload(d, "https://staygreen.test");
    expect(Buffer.byteLength(body)).toBeLessThan(16384);
    expect(JSON.parse(body).links.incident).toContain("inc_a");
    expect(body).not.toContain("�");
  });
  it("rejects mixed public/private DNS answers before opening a socket", async () => {
    const dial = vi.fn();
    const send = pinnedWebhookTransport(async () => ["1.1.1.1", "127.0.0.1"], dial as unknown as typeof connect);
    expect(await send("https://receiver.example.com", "{}", {})).toMatchObject({ kind: "rejected" }); expect(dial).not.toHaveBeenCalled();
  });
  it("pins the checked IP, verifies the original TLS name and never follows a redirect", async () => {
    const s = Object.assign(new EventEmitter(), { authorized: true, write: vi.fn(), destroy: vi.fn() });
    const resolve = vi.fn(async () => ["1.1.1.1"]);
    const dial = vi.fn((_opts, cb) => { queueMicrotask(() => { cb(); s.emit("data", Buffer.from("HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/secret\r\n\r\n")); }); return s; });
    const send = pinnedWebhookTransport(resolve, dial as unknown as typeof connect);
    expect(await send("https://receiver.example.com/hook", "{}", { "Idempotency-Key": "dlv_a" })).toMatchObject({ kind: "rejected" });
    expect(dial).toHaveBeenCalledWith({ host: "1.1.1.1", port: 443, servername: "receiver.example.com", rejectUnauthorized: true }, expect.any(Function));
    expect(resolve).toHaveBeenCalledTimes(1); expect(dial).toHaveBeenCalledTimes(1);
    expect(s.write.mock.calls[0][0]).toContain("Host: receiver.example.com\r\n"); expect(s.destroy).toHaveBeenCalled();
  });
});
