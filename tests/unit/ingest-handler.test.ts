import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { BODY_LIMIT, Breaker, capPayload, handle, LimitCache, maskPayload, PAYLOAD_LIMIT, type Deps, type Kind, type Note, type Recorded } from "../../ingest/src/handler";
import { mintToken, verifyToken } from "../../src/lib/heartbeat-token";

/* The heartbeat Worker's handler (`ingest/src/handler.ts`) with a fake database call: what it
   answers, what it sends to `record_heartbeat`, and what it never does. The real function, the
   rate bound and the `ingest` role are `tests/integration/heartbeat.test.ts`. */

const KEY = randomBytes(32).toString("base64url");
let token = "";
let hash = "";

beforeAll(async () => {
  token = await mintToken(KEY);
  hash = createHash("sha256").update(token).digest("hex");
});

type Call = { hash: string; kind: Kind; payload: Record<string, unknown>; note: Note | null };

function fake(answer: Recorded | Error | ((kind: Kind) => Recorded) = "recorded") {
  const calls: Call[] = [];
  const record = async (h: string, kind: Kind, payload: Record<string, unknown>, note: Note | null) => {
    calls.push({ hash: h, kind, payload, note });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(kind) : answer;
  };
  return { calls, record };
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://in.staygreen.io${path}`, init);
const run = (r: Request, db = fake(), more: Partial<Deps> = {}) => handle(r, { record: db.record, tokenKey: KEY, ...more });

describe("the heartbeat Worker's handler", () => {
  it.each([
    ["", "ping"],
    ["/", "ping"],
    ["/start", "start"],
    ["/fail", "fail"],
  ] as const)("records /<token>%s as a %s, sending the token's SHA-256 and never the token", async (suffix, kind) => {
    const db = fake();
    const res = await run(req(`/${token}${suffix}`), db);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
    expect(db.calls).toEqual([{ hash, kind, payload: {}, note: null }]);
    expect(JSON.stringify(db.calls)).not.toContain(token);
  });

  it("answers 200 ok for a known token whatever its payload will be judged, 404 for an unknown one", async () => {
    expect((await run(req(`/${token}?emails_sent=0`), fake("recorded"))).status).toBe(200);
    const unknown = await run(req(`/${token}`), fake("unknown"));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("not found\n");
  });

  it("answers 404 without a database call for a path that can't be a ping URL", async () => {
    for (const path of ["/", "/favicon.ico", `/${token}/stop`, `/${token}/start/x`, `/${token.slice(1)}`, `/${token}x`, `/x/${token}`]) {
      const db = fake();
      expect((await run(req(path), db)).status, path).toBe(404);
      expect(db.calls, path).toEqual([]);
    }
  });

  it("refuses a token Staygreen never made exactly as an unknown one, without a database call", async () => {
    const other = await mintToken(randomBytes(32).toString("base64url"));
    // One character changed in the tag, and one in the random part.
    const flip = (t: string, i: number) => t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
    const forged = [randomBytes(32).toString("base64url"), other, flip(token, 40), flip(token, 3)];
    const unknown = await run(req(`/${token}`), fake("unknown"));
    const unknownText = await unknown.text();
    for (const t of forged) {
      const db = fake();
      const res = await run(req(`/${t}/fail`), db);
      expect(res.status, t).toBe(404);
      expect(await res.text()).toBe(unknownText);
      expect([...res.headers]).toEqual([...unknown.headers]);
      expect(db.calls, t).toEqual([]);
    }
  });

  it("accepts a token in its one spelling only: the last character's unused bits must be zero", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(token.at(-1)!);
    // 43 characters carry 258 bits for 256: the last character's low two bits are always zero.
    expect(last % 4).toBe(0);
    const twin = token.slice(0, -1) + alphabet[last + 1];
    expect(await verifyToken(KEY, twin)).toBe(false);
    expect(await verifyToken(KEY, token)).toBe(true);
  });

  it("answers 500 to every ping, without a database call, when the Worker has no key or a malformed one", async () => {
    for (const tokenKey of [undefined, "", "short", randomBytes(32).toString("hex")]) {
      const db = fake();
      const res = await run(req(`/${token}`), db, { tokenKey });
      expect(res.status).toBe(500);
      expect(db.calls).toEqual([]);
    }
  });

  it("takes GET, HEAD and POST and refuses the rest", async () => {
    expect((await run(req(`/${token}`, { method: "HEAD" }))).status).toBe(200);
    const put = await run(req(`/${token}`, { method: "PUT", body: "{}" }));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("acknowledges only once the ping is recorded: a database that fails is a 503 to retry, never a 200", async () => {
    const res = await run(req(`/${token}`), fake(new Error("connection refused")));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("after a database error answers 503 for 5 s without trying the database, then tries again", async () => {
    const breaker = new Breaker();
    let now = Date.parse("2026-10-22T12:00:00Z");
    await run(req(`/${token}`), fake(new Error("connection refused")), { breaker, now: () => now });
    const db = fake();
    now += 2_000;
    const held = await run(req(`/${token}/fail`), db, { breaker, now: () => now });
    expect(held.status).toBe(503);
    expect(held.headers.get("retry-after")).toBe("3");
    expect(db.calls).toEqual([]);
    now += 3_000;
    expect((await run(req(`/${token}/fail`), db, { breaker, now: () => now })).status).toBe(200);
    expect(db.calls).toHaveLength(1);
  });

  it("keeps a ping its database refuses from closing the receiver to everyone else's", async () => {
    const breaker = new Breaker();
    const now = () => Date.parse("2026-10-22T12:00:00Z");
    const refusal = Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" });
    const res = await run(req(`/${token}`), fake(refusal), { breaker, now });
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(breaker.open(now())).toBe(0);
    expect((await run(req(`/${token}`), fake(), { breaker, now })).status).toBe(200);
    // A connection that failed carries a code too, and still opens it.
    const refusedConnection = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect((await run(req(`/${token}`), fake(refusedConnection), { breaker, now })).status).toBe(503);
    expect(breaker.open(now())).toBe(5);
  });

  it("stores what jsonb can't hold as text it can: U+0000 dropped, a lone surrogate replaced", async () => {
    let db = fake();
    await run(req(`/${token}?step=a%00b`), db);
    expect(db.calls[0].payload).toEqual({ step: "ab" });
    db = fake();
    const body = JSON.stringify({ "na\u0000me": "x\u0000y", half: "a\ud800b", list: ["\udc00"], nested: { k: "\u0000" } });
    await run(req(`/${token}`, { method: "POST", body, headers: { "content-type": "application/json" } }), db);
    const stored = JSON.stringify(db.calls[0].payload);
    expect(stored).not.toMatch(/\\u0000|\\ud[89ab][0-9a-f]{2}|\\udc[0-9a-f]{2}|\\ud[def][0-9a-f]{2}/i);
    expect(db.calls[0].payload).toEqual({ name: "xy", half: "a�b", list: ["�"], nested: { k: "" } });
  });

  it("reads query parameters on GET, a JSON object on POST, and a form body like query parameters", async () => {
    let db = fake();
    await run(req(`/${token}?emails_sent=12&rows=3`), db);
    expect(db.calls[0].payload).toEqual({ emails_sent: "12", rows: "3" });
    db = fake();
    await run(req(`/${token}?run=7`, { method: "POST", body: JSON.stringify({ emails_sent: 12, ok: true, nested: { a: [1, 2] } }), headers: { "content-type": "application/json" } }), db);
    expect(db.calls[0]).toMatchObject({ payload: { run: "7", emails_sent: 12, ok: true, nested: { a: [1, 2] } }, note: null });
    db = fake();
    await run(req(`/${token}`, { method: "POST", body: "emails_sent=4", headers: { "content-type": "application/x-www-form-urlencoded" } }), db);
    expect(db.calls[0].payload).toEqual({ emails_sent: "4" });
  });

  it("still records a ping whose body can't be read, and says why", async () => {
    let db = fake();
    expect((await run(req(`/${token}`, { method: "POST", body: "[1,2]" }), db)).status).toBe(200);
    expect(db.calls[0]).toMatchObject({ payload: {}, note: "not_json" });
    db = fake();
    await run(req(`/${token}`, { method: "POST", body: "not json at all" }), db);
    expect(db.calls[0].note).toBe("not_json");
    db = fake();
    await run(req(`/${token}?n=1`, { method: "POST", body: JSON.stringify({ x: "y".repeat(BODY_LIMIT) }) }), db);
    expect(db.calls[0]).toMatchObject({ payload: { n: "1" }, note: "too_large" });
  });

  it("masks the payload before it leaves the Worker", async () => {
    const db = fake();
    const body = { emails_sent: 12, token: "abc123", to: "someone@example.com", "x@example.com": 1, key: "sk_live_0123456789abcdefghij", list: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"] };
    await run(req(`/${token}`, { method: "POST", body: JSON.stringify(body) }), db);
    const sent = JSON.stringify(db.calls[0].payload);
    for (const secret of ["abc123", "someone@example.com", "x@example.com", "sk_live_", "eyJhbGci"]) expect(sent).not.toContain(secret);
    expect(db.calls[0].payload.emails_sent).toBe(12);
    expect(db.calls[0].payload.token).toBe("•••");
  });

  it(`keeps at most ${PAYLOAD_LIMIT} bytes of payload, whole fields in order, and says it dropped some`, async () => {
    const db = fake();
    const body: Record<string, string> = {};
    for (let i = 0; i < 40; i++) body[`field_${String(i).padStart(2, "0")}`] = "v".repeat(40);
    await run(req(`/${token}`, { method: "POST", body: JSON.stringify(body) }), db);
    const { payload, note } = db.calls[0];
    expect(note).toBe("truncated");
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(PAYLOAD_LIMIT);
    expect(Object.keys(payload)[0]).toBe("field_00");
    expect(Object.keys(payload).length).toBeGreaterThan(10);
    expect(capPayload({ a: 1 })).toEqual({ payload: { a: 1 }, truncated: false });
  });

  it("never sets a cookie, never reads one, and says not to cache", async () => {
    const db = fake();
    const res = await run(req(`/${token}`, { headers: { cookie: "__session=abc" } }), db);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(db.calls)).not.toContain("__session");
  });

  it("answers a kind over its bound from memory until the minute ends, sparing the database", async () => {
    const cache = new LimitCache();
    let now = Date.parse("2026-10-22T12:00:10Z");
    expect((await run(req(`/${token}`), fake("limited"), { cache, now: () => now })).status).toBe(200);
    const db = fake();
    for (let i = 0; i < 5; i++) expect((await run(req(`/${token}`), db, { cache, now: () => now })).status).toBe(200);
    expect(db.calls).toEqual([]);
    now = Date.parse("2026-10-22T12:01:00Z");
    await run(req(`/${token}`), db, { cache, now: () => now });
    expect(db.calls).toHaveLength(1);
  });

  it("never answers a /fail or a /start from memory because pings were over their bound: each kind reaches the database", async () => {
    const now = () => Date.parse("2026-10-22T12:00:10Z");
    const cache = new LimitCache();
    const db = fake((kind) => (kind === "ping" ? "limited" : "recorded"));
    for (let i = 0; i < 12; i++) await run(req(`/${token}`), db, { cache, now });
    expect((await run(req(`/${token}/fail`), db, { cache, now })).status).toBe(200);
    await run(req(`/${token}/start`), db, { cache, now });
    expect(db.calls.map((c) => c.kind)).toEqual(["ping", "fail", "start"]);
    // And a /fail the database refused is remembered as a /fail, not as the whole token.
    const other = new LimitCache();
    const failing = fake((kind) => (kind === "fail" ? "limited" : "recorded"));
    await run(req(`/${token}/fail`), failing, { cache: other, now });
    await run(req(`/${token}/fail`), failing, { cache: other, now });
    await run(req(`/${token}`), failing, { cache: other, now });
    expect(failing.calls.map((c) => c.kind)).toEqual(["fail", "ping"]);
  });

  it("bounds its memory of limited tokens", () => {
    const cache = new LimitCache(2);
    cache.remember("a", "ping", 0);
    cache.remember("b", "ping", 0);
    cache.remember("c", "ping", 0);
    expect([cache.limited("a", "ping", 1), cache.limited("b", "ping", 1), cache.limited("c", "ping", 1)]).toEqual([false, true, true]);
  });
});

describe("maskPayload", () => {
  it("masks keys and nested values, and leaves numbers and booleans alone", () => {
    expect(maskPayload({ n: 1, ok: false, none: null, deep: { list: ["a@b.co", 3] } })).toEqual({
      n: 1, ok: false, none: null, deep: { list: ["•••", 3] },
    });
  });

  it("hides everything under a secret-named key, whatever its type", () => {
    expect(maskPayload({
      password: "hunter2", token: 4242424242, secret: true, api_key: ["k1", "k2"], session: { id: "s", n: 1 }, cookie: null,
      nested: { authorization: [["Bearer x"]], ok: 1 },
    })).toEqual({
      password: "•••", token: "•••", secret: "•••", api_key: "•••", session: "•••", cookie: "•••",
      nested: { authorization: "•••", ok: 1 },
    });
  });

  it("replaces only the part of a string that looks like a secret, and keeps the rest", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(maskPayload({ to: "Ops team <ops@example.com>", deploy: `deployed ${sha} to production`, note: "all good" })).toEqual({
      to: "Ops team <•••>", deploy: "deployed ••• to production", note: "all good",
    });
  });
});
