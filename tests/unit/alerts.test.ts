import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { membersOf } from "@/lib/alerts/clerk";
import { composeConfirm, composeOpened, composeResolved, composeTest, emailText, evidenceLine, linksFor, requestLine, when, whyLine, zoneOf } from "@/lib/alerts/compose";
import { CONFIRM_MAX_AGE_SEC, confirmUrl, hashConfirmToken, isConfirmToken, isOneClickBody, newConfirmToken, readUnsubscribeToken, unsubscribeToken, unsubscribeUrls } from "@/lib/alerts/links";
import { DISCARD_ADDRESS, findSent, sendEmail, type PostmarkConfig } from "@/lib/alerts/postmark";
import { messageFor, retryAfterSec, type Claimed } from "@/lib/alerts/sender";
import { chatLabel, deepLink, parseCommand, sendTelegram, telegramText, webhookAuthorized } from "@/lib/alerts/telegram";
import { ALERT_CONFIRM_BUDGET, ALERT_TEST_BUDGET, alertBudgetSpent } from "@/lib/budgets";

/* Alerts' pure parts (`docs/emails.md`, `docs/telegram.md`): what a message says, the links that
   act without a sign-in, and how each provider's answer is sorted. Every provider is a fake
   `fetch`; nothing here reaches the network. The receipts, the claims and the sender against a
   real Postgres are `tests/integration/alerts.test.ts`. */

const AT = Date.UTC(2026, 9, 22, 12, 2); // 14:02 in Warsaw (CEST), 12:02 UTC
const inc = {
  id: "inc_7Hq2",
  title: "API health is down",
  severity: "down",
  openedAt: AT,
  resolvedAt: null as number | null,
  evidence: {
    request: "GET /api/health",
    summary: "$.db.ok == true failed: false",
    status: 200,
    assertion: "$.db.ok == true",
    got: "false",
    locations: ["tor1", "sfo3"],
    snippet: '{"db":{"ok":false,"error":"too many connections"},"token":"sk_live_abcdefghijklmnop"}',
  },
};
const about = { appName: "askone", monitorName: "API health", monitorType: "http", pageSlug: "askone" };
const links = linksFor("https://staygreen.io/", inc.id, "askone");

describe("what an alert says", () => {
  it("opens with the app and what broke, then the spec's evidence line, where and since when", () => {
    const m = composeOpened(inc, about, links);
    expect(m.subject).toBe("askone: API health is down");
    expect(m.lines[0]).toBe("GET /api/health returned 200, but $.db.ok == true failed: got false.");
    expect(m.lines[1]).toBe("Seen from Toronto and San Francisco since 12:02 UTC on 22 October.");
    expect(m.lines).toContain("Incident inc_7Hq2: https://staygreen.io/app/incidents/inc_7Hq2");
    expect(m.lines).toContain("Status page: https://staygreen.io/s/askone");
  });

  it("masks the snippet again, whatever the incident holds", () => {
    const text = composeOpened(inc, about, links).lines.join("\n");
    expect(text).toContain("too many connections");
    expect(text).not.toContain("sk_live_abcdefghijklmnop");
  });

  it("writes times in the recipient's zone and says which, else UTC", () => {
    expect(when(AT, "Europe/Warsaw")).toBe("14:02 CEST on 22 October");
    expect(when(AT, null)).toBe("12:02 UTC on 22 October");
    expect(when(AT, "Not/AZone")).toBe("12:02 UTC on 22 October");
    expect(zoneOf("Not/AZone")).toBe("UTC");
    expect(when(AT, "America/Toronto")).toMatch(/^08:02 (EDT|UTC-4) on 22 October$/);
  });

  it("words a failure without an assertion from the probe's own summary", () => {
    expect(evidenceLine({ request: "GET https://example.com/health", summary: "Answered 503, expected 2xx", status: 503 }, "http")).toBe("GET https://example.com/health: Answered 503, expected 2xx.");
    expect(evidenceLine({ request: "GET /x", summary: "" }, "http")).toBe("GET /x failed.");
    // A key in the address's query string, or in an assertion's expected value, never leaves in an alert.
    expect(requestLine("GET https://example.com/health?token=abc123&x=1#top")).toBe("GET https://example.com/health");
    const keyed = evidenceLine({ request: "GET https://example.com/health?key=sk_live_abcdefghijklmnop", summary: "Answered 200", status: 200, assertion: '$.key == "sk_live_abcdefghijklmnop"', got: "x" }, "http");
    expect(keyed).toContain("GET https://example.com/health returned 200");
    expect(keyed).not.toContain("sk_live_abcdefghijklmnop");
    expect(keyed).not.toContain("?key");
    expect(evidenceLine({ request: "GET /x", summary: "the run was missed" }, "heartbeat")).toBe("The run was missed.");
  });

  it("says how long it was down and what ended it", () => {
    const done = { ...inc, resolvedAt: AT + 7 * 60_000 };
    const m = composeResolved(done, about, links, "up");
    expect(m.subject).toBe("askone: API health recovered");
    expect(m.lines[0]).toMatch(/^Down for 7 ?m(in)?\. It passed twice in a row at 12:09 UTC on 22 October\.$/);
    expect(composeResolved(done, { ...about, monitorType: "heartbeat" }, links, "up").lines[0]).toContain("A good ping arrived at");
    expect(composeResolved(done, about, links, "degraded").lines).toContain("It's answering again, but slowly, so it reads as degraded.");
  });

  it("ends every email with why it came and the link that stops it", () => {
    const body = emailText(composeTest("https://staygreen.io", null, AT), { why: whyLine("members", null), unsubscribeUrl: "https://staygreen.io/unsubscribe/x" });
    expect(body).toContain("A test of your Staygreen alerts, sent at 12:02 UTC on 22 October.");
    expect(body.trimEnd().split("\n").slice(-3)).toEqual(["--", "You get this because you're a member of a Staygreen workspace and asked for a test.", "Stop these emails: https://staygreen.io/unsubscribe/x"]);
    expect(whyLine("address", "askone")).toContain("this address was added to get Staygreen alerts for askone, and confirmed");
    expect(whyLine("chat", "askone")).toContain("this chat was connected");
  });

  it("asks an added address to confirm, and says ignoring it is the way to say no", () => {
    const m = composeConfirm(["askone", "quizroom"], confirmUrl("https://staygreen.io", "t"), CONFIRM_MAX_AGE_SEC / 86_400);
    expect(m.subject).toBe("Confirm Staygreen alerts");
    expect(m.lines.join(" ")).toContain("for askone and quizroom");
    expect(m.lines).toContain("https://staygreen.io/alerts/confirm/t");
    expect(m.lines.join(" ")).toContain("within 7 days");
    expect(m.lines.join(" ")).toContain("ignore it");
  });

  it("builds a receipt's message from what the claim returned, or none when its incident is gone", () => {
    const claimed = {
      event: "opened",
      incident: { ...inc, evidence: inc.evidence as Record<string, unknown> },
      monitor: { id: "mon_1", name: "API health", type: "http" },
      app: { id: "app_1", name: "askone" },
      pageSlug: "askone",
      stateAfter: null,
    } as unknown as Claimed;
    expect(messageFor(claimed, "https://staygreen.io", null, AT)?.subject).toBe("askone: API health is down");
    expect(messageFor({ ...claimed, incident: null } as Claimed, "https://staygreen.io", null, AT)).toBeNull();
    expect(messageFor({ ...claimed, event: "test" } as Claimed, "https://staygreen.io", null, AT)?.subject).toBe("Staygreen: test alert");
  });
});

describe("links that act without a sign-in", () => {
  const secret = randomBytes(32);
  const id = `dlv_${"a1".repeat(12)}`;

  it("signs an unsubscribe link for one receipt, the same on every retry", () => {
    const t = unsubscribeToken(secret, id);
    expect(t).toBe(unsubscribeToken(secret, id));
    expect(readUnsubscribeToken(secret, t)).toBe(id);
    expect(unsubscribeUrls("https://staygreen.io/", t)).toEqual({ page: `https://staygreen.io/unsubscribe/${t}`, oneClick: `https://staygreen.io/api/alerts/unsubscribe/${t}` });
  });

  it("refuses a link for another receipt, from another secret, or tampered with", () => {
    const t = unsubscribeToken(secret, id);
    const other = `dlv_${"b2".repeat(12)}`;
    expect(readUnsubscribeToken(secret, `${other}.${t.split(".")[1]}`)).toBeNull();
    expect(readUnsubscribeToken(randomBytes(32), t)).toBeNull();
    expect(readUnsubscribeToken(secret, `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(readUnsubscribeToken(secret, "nonsense")).toBeNull();
    expect(() => unsubscribeToken(secret, "not-a-delivery")).toThrow();
  });

  it("makes a confirmation token of 256 random bits and stores only its hash", () => {
    const a = newConfirmToken();
    expect(isConfirmToken(a.token)).toBe(true);
    expect(a.hash).toBe(hashConfirmToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newConfirmToken().token).not.toBe(a.token);
    expect(isConfirmToken("short")).toBe(false);
  });
});

type Call = { url: string; init?: RequestInit };
const fakeFetch = (answer: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};
const email = { to: "a@example.com", subject: "s", text: "t", tag: "alert" as const, metadata: { delivery: "dlv_x" } };
const pm = (f: typeof globalThis.fetch, extra: Partial<PostmarkConfig> = {}): PostmarkConfig => ({ token: "00000000-0000-4000-8000-000000000000", from: "alerts@staygreen.io", fetch: f, ...extra });

describe("Postmark", () => {
  it("sends plain text on the outbound stream with tracking off, and the receipt's id in metadata", async () => {
    const f = fakeFetch(() => Response.json({ ErrorCode: 0, MessageID: "m-1" }));
    expect(await sendEmail(pm(f.fetch), { ...email, headers: [{ Name: "List-Unsubscribe", Value: "<u>" }] })).toEqual({ kind: "sent", messageId: "m-1", redirected: false });
    const body = JSON.parse(String(f.calls[0].init?.body));
    expect(body).toMatchObject({ To: "a@example.com", TextBody: "t", MessageStream: "outbound", TrackOpens: false, TrackLinks: "None", Metadata: { delivery: "dlv_x" }, Headers: [{ Name: "List-Unsubscribe", Value: "<u>" }] });
    expect(body.HtmlBody).toBeUndefined();
    expect((f.calls[0].init?.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBeDefined();
  });

  it("sends development email to the redirect address and says so", async () => {
    const f = fakeFetch(() => Response.json({ ErrorCode: 0, MessageID: "m-2" }));
    expect(await sendEmail(pm(f.fetch, { redirectTo: DISCARD_ADDRESS }), email)).toMatchObject({ kind: "sent", redirected: true });
    expect(JSON.parse(String(f.calls[0].init?.body)).To).toBe(DISCARD_ADDRESS);
  });

  it("sorts every answer into sent, refused, try later, or unknown, in our words only", async () => {
    const answer = async (r: Response | Error) => sendEmail(pm(fakeFetch(() => (r instanceof Error ? Promise.reject(r) : r)).fetch), email);
    const leak = "SECRET-BODY-TEXT";
    expect(await answer(Response.json({ ErrorCode: 406, Message: leak }, { status: 422 }))).toEqual({ kind: "rejected", code: 406, detail: expect.stringContaining("error 406") });
    expect(JSON.stringify(await answer(Response.json({ ErrorCode: 300, Message: leak }, { status: 422 })))).not.toContain(leak);
    expect(await answer(new Response("{}", { status: 429 }))).toMatchObject({ kind: "retry" });
    expect(await answer(new Response("{}", { status: 503 }))).toMatchObject({ kind: "retry" });
    expect(await answer(new Response("{}", { status: 401 }))).toMatchObject({ kind: "retry" });
    expect(await answer(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toMatchObject({ kind: "retry" });
    expect(await answer(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toMatchObject({ kind: "unknown" });
    expect(await answer(Response.json({ ErrorCode: 0 }))).toMatchObject({ kind: "unknown" });
  });

  it("finds a message by the receipt's id, or says it can't tell", async () => {
    const found = fakeFetch(() => Response.json({ TotalCount: 1, Messages: [{ MessageID: "m-3" }] }));
    expect(await findSent(pm(found.fetch), "delivery", "dlv_x")).toEqual({ kind: "found", messageId: "m-3" });
    expect(new URL(found.calls[0].url).searchParams.get("metadata_delivery")).toBe("dlv_x");
    expect(await findSent(pm(fakeFetch(() => Response.json({ TotalCount: 0, Messages: [] })).fetch), "delivery", "dlv_x")).toEqual({ kind: "none" });
    expect(await findSent(pm(fakeFetch(() => new Response("{}", { status: 500 })).fetch), "delivery", "dlv_x")).toMatchObject({ kind: "error" });
    expect(await findSent(pm(fakeFetch(() => Response.json({})).fetch), "delivery", "dlv_x")).toMatchObject({ kind: "error" });
  });
});

describe("Telegram", () => {
  const tg = (f: typeof globalThis.fetch) => ({ token: "123456:fake", fetch: f });

  it("reads /start with its code, a bare /start, and /stop, addressed to the bot or not", () => {
    expect(parseCommand("/start abc_DEF-123")).toEqual({ cmd: "start", code: "abc_DEF-123" });
    expect(parseCommand("/start@ExampleStatusBot abc")).toEqual({ cmd: "start", code: "abc" });
    expect(parseCommand("/start")).toEqual({ cmd: "start", code: null });
    expect(parseCommand(" /stop ")).toEqual({ cmd: "stop" });
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/start a b")).toBeNull();
    expect(parseCommand(42)).toBeNull();
  });

  it("names a chat as the screen shows it", () => {
    expect(chatLabel({ type: "private", username: "alex", first_name: "Alex" })).toBe("@alex");
    expect(chatLabel({ type: "private", first_name: "Alex", last_name: "K" })).toBe("Alex K");
    expect(chatLabel({ type: "supergroup", title: "Ops" })).toBe("Ops");
    expect(chatLabel({ type: "private" })).toBeNull();
  });

  it("puts the subject first, says how to stop, and stays inside Telegram's limit", () => {
    const text = telegramText(composeOpened(inc, about, links), whyLine("chat", "askone"));
    expect(text.split("\n")[0]).toBe("askone: API health is down");
    expect(text).toContain("Send /stop to stop Staygreen alerts in this chat.");
    expect(telegramText({ subject: "s", lines: ["x".repeat(5000)] }, "w").length).toBe(4096);
  });

  it("sorts Telegram's answers, and marks a chat that blocked the bot as gone", async () => {
    const send = (r: Response) => sendTelegram(tg(fakeFetch(() => r).fetch), "42", "hi");
    expect(await send(Response.json({ ok: true, result: { message_id: 7 } }))).toEqual({ kind: "sent", messageId: "7", redirected: false });
    expect(await send(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 12 } }, { status: 429 }))).toMatchObject({ kind: "retry", retryAfterSec: 12 });
    expect(await send(Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }))).toMatchObject({ kind: "rejected", gone: true });
    const notFound = await send(Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }));
    expect(notFound).toMatchObject({ kind: "rejected", gone: false, detail: "Telegram can't find this chat any more." });
    expect(await send(new Response("{}", { status: 502 }))).toMatchObject({ kind: "retry" });
  });

  it("never puts the bot's token in what it returns", async () => {
    const r = await sendTelegram(tg(fakeFetch(() => Promise.reject(new TypeError("fetch failed 123456:fake"))).fetch), "42", "hi");
    expect(JSON.stringify(r)).not.toContain("123456:fake");
  });

  it("checks the webhook's secret token exactly, and makes deep links", () => {
    expect(webhookAuthorized("s3cret", "s3cret")).toBe(true);
    expect(webhookAuthorized("s3cre", "s3cret")).toBe(false);
    expect(webhookAuthorized(null, "s3cret")).toBe(false);
    expect(webhookAuthorized("", "")).toBe(false);
    expect(deepLink("ExampleStatusBot", "abc")).toBe("https://t.me/ExampleStatusBot?start=abc");
  });
});

describe("members from Clerk", () => {
  const users = [
    { id: "user_a", first_name: "Ann", last_name: "A", primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: "ann@example.com", verification: { status: "verified" } }], timezone: "Europe/Warsaw" },
    { id: "user_b", username: "bob", primary_email_address_id: "e2", email_addresses: [{ id: "e2", email_address: "bob@example.com", verification: { status: "unverified" } }] },
    { id: "user_c", banned: true, primary_email_address_id: "e3", email_addresses: [{ id: "e3", email_address: "c@example.com", verification: { status: "verified" } }] },
  ];

  it("reads only the members whose role can see monitors, with their verified primary address", async () => {
    const f = fakeFetch(({ url }) =>
      url.includes("/memberships")
        ? Response.json({ data: [{ role: "org:admin", public_user_data: { user_id: "user_a" } }, { role: "org:admin", public_user_data: { user_id: "user_b" } }, { role: "org:admin", public_user_data: { user_id: "user_c" } }, { role: "org:member", public_user_data: { user_id: "user_d" } }], total_count: 4 })
        : Response.json(users),
    );
    expect(await membersOf("sk_test_x", "org_1", f.fetch)).toEqual([
      { userId: "user_a", name: "Ann A", email: "ann@example.com", timezone: "Europe/Warsaw" },
      { userId: "user_b", name: "bob", email: null, timezone: null },
    ]);
    expect(f.calls[1].url).not.toContain("user_d");
  });

  it("answers no members for an organization Clerk no longer has, and null when Clerk fails", async () => {
    expect(await membersOf("sk_test_x", "org_gone", fakeFetch(() => new Response("{}", { status: 404 })).fetch)).toEqual([]);
    expect(await membersOf("sk_test_x", "org_1", fakeFetch(() => new Response("{}", { status: 500 })).fetch)).toBeNull();
    expect(await membersOf("sk_test_x", "org_1", fakeFetch(() => Promise.reject(new Error("down"))).fetch)).toBeNull();
  });
});

describe("retries and budgets", () => {
  it("backs off from 30 seconds to an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(retryAfterSec)).toEqual([30, 60, 120, 300, 600, 1800, 3600, 3600, 3600]);
  });

  it("words a spent alert budget with its own numbers", () => {
    expect(alertBudgetSpent("alert_test", "member")).toBe(`You've sent ${ALERT_TEST_BUDGET.member.limit} test alerts in 10 minutes, which is as many as one person can.`);
    expect(alertBudgetSpent("alert_confirm", "workspace")).toBe(`This workspace has used ${ALERT_CONFIRM_BUDGET.workspace.limit} channel setup attempts in an hour, which is as many as a workspace can.`);
  });
});

describe("the one-click unsubscribe body", () => {
  it("is RFC 8058's form field and nothing else", () => {
    expect(isOneClickBody("List-Unsubscribe=One-Click")).toBe(true);
    expect(isOneClickBody("a=b&List-Unsubscribe=One-Click")).toBe(true);
    for (const body of ["", "List-Unsubscribe=one-click", "List-Unsubscribe=One-Click-Extra", "{}"]) expect(isOneClickBody(body), body).toBe(false);
  });
});
