import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import tlsMod from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ask } from "@/checks/dns";
import type { MonitorRow } from "@/lib/monitor-input";
import { runTest, treeOf } from "@/lib/monitor-test";
import type { TestOutcome } from "@/lib/test-result";
import { assertionFor } from "../../src/lib/test-result";

/* Testing a monitor before saving it (`docs/flows.md § Testing a monitor`): the runner the action
   calls, against servers on this machine. The production guard refuses loopback, so these tests
   pass one that admits it, except where the refusal is the point: a private address, and a
   redirect to one. Nothing here reaches past this machine; DNS answers come from a fake. The
   fake key is assembled at run time, as in `checks-mask.test.ts`. */

const fixture = (f: string) => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));
const ca = fixture("ca.pem");
const allow = () => true;
const SECRET = "Sup3rSecretHeaderValue_9f8e7d";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];

let web: http.Server;
let tcp: net.Server;
let good: tlsMod.Server;
let wrong: tlsMod.Server;
let base = "";
let tcpPort = 0;
let goodPort = 0;
let wrongPort = 0;

// Dual-stack: localhost may resolve only to ::1; IP-literal checks still use 127.0.0.1.
const listen = (s: net.Server) => new Promise<number>((r) => s.listen({ port: 0, host: "::", ipv6Only: false }, () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  web = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push({ path, headers: req.headers });
    const h = routes.get(path);
    if (h) h(req, res);
    else res.writeHead(404).end("not found");
  });
  tcp = net.createServer((s) => s.end());
  good = tlsMod.createServer({ key: fixture("localhost.key"), cert: fixture("localhost.pem") }, (s) => s.end());
  wrong = tlsMod.createServer({ key: fixture("wrong.key"), cert: fixture("wrong.pem") }, (s) => s.end());
  base = `http://127.0.0.1:${await listen(web)}`;
  tcpPort = await listen(tcp);
  goodPort = await listen(good);
  wrongPort = await listen(wrong);

  routes.set("/json", (_, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", db: { ok: true, latency_ms: 42 }, items: [1, "2"], "odd key": null })),
  );
  routes.set("/down", (_, res) => res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ db: { ok: false } })));
  // Everything a careless endpoint echoes: the caller's own header, a session, an email, a key.
  routes.set("/echo", (req, res) =>
    res
      .writeHead(200, {
        "content-type": "application/json",
        "set-cookie": ["session=abc123def456; Path=/; HttpOnly", "theme=dark; Path=/"],
        "x-echo": String(req.headers["x-api-key"]),
        authorization: "Bearer zzz",
      })
      .end(JSON.stringify({ seen: req.headers["x-api-key"], user: "ana@example.com", token: "plain-looking", nested: { list: [String(req.headers["x-api-key"])] } })),
  );
  routes.set("/echo-token", (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ debug: String(req.headers.authorization).replace(/^Bearer /, "") })));
  routes.set("/to-echo", (req, res) => res.writeHead(302, { location: `/echo?k=${encodeURIComponent(String(req.headers["x-api-key"]))}` }).end());
  routes.set("/to-private", (_, res) => res.writeHead(302, { location: "http://127.0.0.2:1/ok" }).end());
  routes.set("/to-json", (_, res) => res.writeHead(301, { location: "/json" }).end());
  routes.set("/page", (_, res) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>Sign in</h1>"));
  routes.set("/big", (_, res) => res.writeHead(200, { "content-type": "application/json" }).end("[" + '"xxxxxxxxxx",'.repeat(10_000) + '"end"]'));
  routes.set("/png", (_, res) => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])));
  routes.set("/hang", () => {});
});

afterAll(async () => {
  web.closeAllConnections();
  for (const s of [web, tcp, good, wrong]) await new Promise((r) => s.close(r));
});

const httpRow = (target: string, config: Record<string, unknown> = {}): MonitorRow => ({
  type: "http",
  appId: "app_aaaaaaaaaaaaaaaaaaaaaaaa",
  name: "API",
  target,
  targetHost: new URL(target).hostname,
  config: { method: "GET", expect: "2xx", keyword: null, slowMs: 3000, timeoutSec: 15, assertions: [], ...config },
  secrets: [],
  fixedIntervalSec: null,
});
const tcpRow = (host: string, port: number, tls = false): MonitorRow => ({ type: "tcp", appId: "app_a", name: "port", target: `${host}:${port}`, targetHost: host, config: { host, port, tls }, secrets: [], fixedIntervalSec: null });
const sslRow = (host: string): MonitorRow => ({ type: "ssl", appId: "app_a", name: host, target: host, targetHost: host, config: { host }, secrets: [], fixedIntervalSec: 21600 });
const dnsRow = (record: string, name: string, expected: string): MonitorRow => ({ type: "dns", appId: "app_a", name, target: `${record} ${name}`, targetHost: name, config: { record, name, expected }, secrets: [], fixedIntervalSec: 600 });

const http_ = (o: TestOutcome) => {
  if (o.type !== "http") throw new Error(`expected an HTTP test, got ${o.type}`);
  return o.http;
};

describe("the address guard", () => {
  it("refuses a private address under the production guard, before anything connects", async () => {
    const before = seen.length;
    const o = await runTest(httpRow(`${base}/json`), {}, 10_000);
    expect(o).toMatchObject({ ok: false, failure: { kind: "private" } });
    expect(http_(o)).toMatchObject({ status: undefined, redirects: [], headers: [], body: undefined });
    expect(seen.length).toBe(before);
    expect((await runTest(tcpRow("127.0.0.1", tcpPort), {}, 10_000)).failure?.kind).toBe("private");
    expect((await runTest(tcpRow("10.0.0.1", 22), {}, 10_000)).failure?.kind).toBe("private");
    expect((await runTest(sslRow("169.254.169.254"), {}, 10_000)).failure?.kind).toBe("private");
  });

  it("asks again at every redirect, refuses one that leads somewhere private, and shows the hop", async () => {
    const o = await runTest(httpRow(`${base}/to-private`), {}, 10_000, { allow: (a) => a === "127.0.0.1" });
    expect(o).toMatchObject({ ok: false, failure: { kind: "private", message: "A redirect led to 127.0.0.2 is a private address" } });
    expect(http_(o).redirects).toEqual([{ status: 302, location: "http://127.0.0.2:1/ok" }]);
    expect(http_(o).body).toBeUndefined();
  });
});

describe("an HTTP test", () => {
  it("shows the status, the redirects followed, the time against the slow threshold, the headers and the body", async () => {
    const o = await runTest(httpRow(`${base}/to-json`, { slowMs: 5000 }), {}, 10_000, { allow });
    expect(o).toMatchObject({ ok: true, type: "http", timeoutSec: 10 });
    expect(o.slow).toBeUndefined();
    const h = http_(o);
    expect(h).toMatchObject({ status: 200, statusOk: true, expect: "2xx", slowMs: 5000, address: "127.0.0.1", redirects: [{ status: 301, location: "/json" }] });
    expect(h.headers).toContainEqual(["content-type", "application/json"]);
    expect(h.body).toMatchObject({ kind: "json", truncated: false, contentType: "application/json" });
    expect(h.body?.json).toEqual({
      t: "object",
      more: 0,
      entries: [
        { k: "status", n: { t: "string", v: "ok" } },
        { k: "db", n: { t: "object", more: 0, entries: [{ k: "ok", n: { t: "boolean", v: true } }, { k: "latency_ms", n: { t: "number", v: 42 } }] } },
        { k: "items", n: { t: "array", more: 0, items: [{ t: "number", v: 1 }, { t: "string", v: "2" }] } },
        { k: "odd key", n: { t: "null" } },
      ],
    });
  });

  it("judges every assertion against the answer, even when the status already failed", async () => {
    const o = await runTest(httpRow(`${base}/down`, { assertions: [{ path: "$.db.ok", op: "==", value: "false" }, { path: "$.cache", op: "exists", value: "" }] }), {}, 10_000, { allow });
    expect(o).toMatchObject({ ok: false, failure: { kind: "status", message: "Answered 503, expected 2xx" } });
    expect(http_(o).statusOk).toBe(false);
    expect(http_(o).assertions.map((a) => [a.path, a.pass, a.got])).toEqual([
      ["$.db.ok", true, "false"],
      ["$.cache", false, undefined],
    ]);
  });

  it("says whether the keyword is there, and shows a body that isn't JSON as text", async () => {
    const found = await runTest(httpRow(`${base}/page`, { keyword: "Sign in" }), {}, 10_000, { allow });
    expect(http_(found)).toMatchObject({ keyword: { text: "Sign in", found: true }, body: { kind: "text", text: "<h1>Sign in</h1>" } });
    const missing = await runTest(httpRow(`${base}/page`, { keyword: "Dashboard" }), {}, 10_000, { allow });
    expect(missing).toMatchObject({ ok: false, failure: { kind: "keyword" } });
    expect(http_(missing).keyword).toEqual({ text: "Dashboard", found: false });
  });

  it("reads at most 64 KB and says it was cut there", async () => {
    const o = await runTest(httpRow(`${base}/big`), {}, 10_000, { allow });
    expect(http_(o).body).toMatchObject({ kind: "text", truncated: true, bytes: 64 * 1024 });
  });

  it("names a body that isn't text instead of showing it, and an empty one", async () => {
    expect(http_(await runTest(httpRow(`${base}/png`), {}, 10_000, { allow })).body).toMatchObject({ kind: "binary", bytes: 7 });
    expect(http_(await runTest(httpRow(`${base}/json`, { method: "HEAD" }), {}, 10_000, { allow })).body).toMatchObject({ kind: "empty" });
  });

  it("is given at most what remains of the action's time", async () => {
    const started = performance.now();
    const o = await runTest(httpRow(`${base}/hang`), {}, 1_500, { allow });
    expect(o).toMatchObject({ ok: false, timeoutSec: 1, failure: { kind: "timeout", message: "No answer within 1 s" } });
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});

describe("masking", () => {
  it("sends the secret header to the target and masks it, and everything else secret, out of what comes back", async () => {
    const o = await runTest(httpRow(`${base}/to-echo`), { "x-api-key": SECRET }, 10_000, { allow });
    expect(seen.at(-1)).toMatchObject({ path: "/echo" });
    expect(seen.at(-1)?.headers["x-api-key"]).toBe(SECRET);
    const all = JSON.stringify(o);
    for (const leak of [SECRET, encodeURIComponent(SECRET), "abc123def456", "ana@example.com", "plain-looking", "Bearer zzz"]) expect(all).not.toContain(leak);

    const h = http_(o);
    expect(h.redirects).toEqual([{ status: 302, location: "/echo?k=•••" }]);
    expect(h.headers).toContainEqual(["set-cookie", "session=•••; Path=/; HttpOnly"]);
    expect(h.headers).toContainEqual(["set-cookie", "theme=•••; Path=/"]);
    expect(h.headers).toContainEqual(["x-echo", "•••"]);
    expect(h.headers).toContainEqual(["authorization", "•••"]);
    expect(h.body?.text).toContain('"user":"•••"');
    expect(h.body?.json).toMatchObject({
      t: "object",
      entries: [
        { k: "seen", n: { t: "string", v: "•••", masked: true } },
        { k: "user", n: { t: "string", v: "•••", masked: true } },
        { k: "token", n: { t: "string", v: "•••", masked: true } },
        { k: "nested", n: { t: "object", entries: [{ k: "list", n: { t: "array", items: [{ t: "string", v: "•••", masked: true }] } }] } },
      ],
    });
  });

  it("judges nothing a secret holds, so guessing at an echoed header by keyword or assertion learns nothing", async () => {
    const guesses = [
      { path: "$.seen", op: "contains" as const, value: SECRET.slice(0, 6) },
      { path: "$.nested.list[0]", op: "==" as const, value: SECRET },
    ];
    const o = await runTest(httpRow(`${base}/echo`, { assertions: guesses }), { "x-api-key": SECRET }, 10_000, { allow });
    expect(o.ok).toBe(false);
    expect(http_(o).assertions.map((a) => a.pass)).toEqual([false, false]);
    const k = await runTest(httpRow(`${base}/echo`, { keyword: SECRET.slice(-8) }), { "x-api-key": SECRET }, 10_000, { allow });
    expect(k.ok).toBe(false);
    expect(http_(k).keyword).toEqual({ text: SECRET.slice(-8), found: false });
    // What isn't the monitor's own secret is judged as it came.
    const fair = await runTest(httpRow(`${base}/echo`, { keyword: "ana@", assertions: [{ path: "$.token", op: "==", value: "plain-looking" }] }), { "x-api-key": SECRET }, 10_000, { allow });
    expect(fair.ok).toBe(true);
  });

  it("hides the token after Bearer wherever it comes back, so choosing it adds only exists", async () => {
    const o = await runTest(httpRow(`${base}/echo-token`), { authorization: "Bearer s3cr3t-value-9f" }, 10_000, { allow });
    const h = http_(o);
    expect(JSON.stringify(h)).not.toContain("s3cr3t-value-9f");
    const node = h.body?.json?.t === "object" ? h.body.json.entries.find((e) => e.k === "debug")?.n : undefined;
    expect(node).toMatchObject({ t: "string", masked: true });
    expect(assertionFor(node!)).toEqual({ op: "exists", value: "" });
  });

  it("masks the failure's sentence and what a failed assertion got", async () => {
    const o = await runTest(httpRow(`${base}/echo`, { assertions: [{ path: "$.seen", op: "==", value: "x" }] }), { "x-api-key": SECRET }, 10_000, { allow });
    expect(o.failure).toEqual({ kind: "assertion", message: '$.seen == x failed: got "•••"' });
    expect(http_(o).assertions[0].got).toBe('"•••"');
  });

  it("hides a key that looks like a secret, and the tree marks it so no path names it", () => {
    const key = ["sk_", "live_", "0123456789abcdefABCDEF"].join("");
    expect(treeOf({ [key]: 1 })).toEqual({ t: "object", more: 0, entries: [{ k: "•••", masked: true, n: { t: "number", v: 1 } }] });
  });

  it("hides a secret echoed as a number or a boolean in the tree, so its leaf can only assert that it exists", () => {
    expect(treeOf({ id: 8392017465, n: 7 }, ["Bearer 8392017465"])).toEqual({
      t: "object",
      more: 0,
      entries: [
        { k: "id", n: { t: "string", v: "•••", masked: true } },
        { k: "n", n: { t: "number", v: 7 } },
      ],
    });
  });

  it("stops the tree at its size and depth, and cuts a long string, saying so", () => {
    const wide = treeOf(Array.from({ length: 3000 }, (_, i) => i));
    expect(wide).toMatchObject({ t: "array" });
    if (wide.t !== "array") throw new Error("not an array");
    expect(wide.items.length + wide.more).toBe(3000);
    expect(wide.more).toBeGreaterThan(0);
    let deep: unknown = "bottom";
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(JSON.stringify(treeOf(deep))).not.toContain("bottom");
    expect(treeOf("y".repeat(400))).toEqual({ t: "string", v: "y".repeat(300), cut: true });
  });
});

describe("a TCP test", () => {
  it("says it connected, and in how long", async () => {
    const o = await runTest(tcpRow("127.0.0.1", tcpPort), {}, 10_000, { allow });
    expect(o).toMatchObject({ ok: true, type: "tcp", timeoutSec: 10, tcp: { host: "127.0.0.1", port: tcpPort, tls: false, address: "127.0.0.1" } });
  });

  it("tells a refused port from a TLS handshake that failed", async () => {
    expect((await runTest(tcpRow("127.0.0.1", 1), {}, 10_000, { allow })).failure).toEqual({ kind: "connect", message: "Connection refused" });
    expect((await runTest(tcpRow("localhost", goodPort, true), {}, 10_000, { allow, ca })).ok).toBe(true);
    expect((await runTest(tcpRow("localhost", goodPort, true), {}, 10_000, { allow })).failure?.kind).toBe("tls");
  });
});

describe("an SSL test", () => {
  const now = () => Date.parse("2026-10-22T00:00:00Z");

  // The form saves no port, so a monitor's certificate is read on 443; the fixtures listen
  // elsewhere, and the runner reads a stored `port` as the probe does.
  const run = (port: number, opts: { ca?: Buffer } = {}) => runTest({ ...sslRow("localhost"), config: { host: "localhost", port } }, {}, 10_000, { allow, now, ...opts });

  it("shows the issuer, the expiry, the days left, the names it covers, and that the name matches", async () => {
    const ok = await run(goodPort, { ca });
    expect(ok).toMatchObject({ ok: true, type: "ssl", ssl: { host: "localhost", address: expect.stringMatching(/^(127\.0\.0\.1|::1)$/), nameMatches: true, trusted: true, subject: "localhost" } });
    if (ok.type !== "ssl") throw new Error("not ssl");
    expect(ok.ssl.issuer).toBeTruthy();
    expect(ok.ssl.names).toContain("localhost");
    expect(ok.ssl.daysLeft).toBeGreaterThan(7000);
    expect(ok.ssl.expiresAt).toMatch(/^2046-/);
  });

  it("tells a certificate for another name from a chain nobody vouches for", async () => {
    expect(await run(wrongPort, { ca })).toMatchObject({ ok: false, failure: { kind: "cert", message: "The certificate isn't for localhost" }, ssl: { nameMatches: false, trusted: true } });
    expect(await run(goodPort)).toMatchObject({ ok: false, failure: { kind: "cert" }, ssl: { nameMatches: true, trusted: false } });
  });

  it("has nothing to show when nothing answered", async () => {
    expect(await run(1)).toMatchObject({ ok: false, failure: { kind: "connect" }, ssl: { names: [], nameMatches: null, trusted: null, issuer: null } });
  });
});

describe("a DNS test", () => {
  const ask = (by: Record<string, string[] | string>): Ask => async (server) => {
    const a = by[server];
    if (typeof a === "string") throw Object.assign(new Error(a), { code: a });
    return a;
  };

  it("shows what each resolver answered against what's expected", async () => {
    const o = await runTest(dnsRow("A", "example.com", "76.76.21.21"), {}, 10_000, { dnsAsk: ask({ "1.1.1.1": ["76.76.21.21"], "8.8.8.8": "ENODATA" }) });
    expect(o).toMatchObject({
      ok: true,
      type: "dns",
      dns: {
        record: "A",
        name: "example.com",
        expected: "76.76.21.21",
        resolvers: [
          { id: "cloudflare", label: "Cloudflare (1.1.1.1)", answers: ["76.76.21.21"], matches: true },
          { id: "google", label: "Google (8.8.8.8)", error: "No record of this type", matches: false },
        ],
      },
    });
  });

  it("ends a resolver that never answers a second after its time, so the test still ends", async () => {
    const started = performance.now();
    const o = await runTest(dnsRow("A", "example.com", "1.2.3.4"), {}, 1_000, { dnsAsk: () => new Promise(() => {}) });
    expect(o).toMatchObject({ ok: false, timeoutSec: 1, failure: { kind: "timeout", message: "Neither resolver answered in time" } });
    expect(performance.now() - started).toBeLessThan(2_600);
  });
});
