import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkHttp, statusMatches, type HttpCheck } from "../../src/checks/http";
import { bodyText } from "../../src/checks/mask";
import { USER_AGENT } from "../../src/checks/types";
import { healthJson } from "../../src/lib/health-body";
import { BOT_PROTECTION } from "../../src/lib/bot-protection";

/* HTTP(S) checks (`spec.md § 3.1`) against servers on this machine. The default address guard
   refuses loopback, so these tests pass a guard that admits it; one test proves the default
   refuses. */

const tls = (f: string) => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));
const allow = () => true;

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
const routes = new Map<string, Handler>();
const seen: { path: string; headers: http.IncomingHttpHeaders; method?: string }[] = [];

function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push({ path, headers: req.headers, method: req.method });
    const h = routes.get(path);
    if (!h) {
      res.writeHead(404).end("not found");
      return;
    }
    h(req, res, Buffer.concat(chunks).toString("utf8"));
  });
}

let plain: http.Server;
let other: http.Server;
let secure: https.Server;
let wrong: https.Server;
let base = "";
let otherBase = "";
let secureBase = "";
let wrongBase = "";

// Dual-stack: localhost may resolve only to ::1; IP-literal checks still use 127.0.0.1.
const listen = (s: http.Server | https.Server) => new Promise<number>((r) => s.listen({ port: 0, host: "::", ipv6Only: false }, () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  plain = http.createServer(handle);
  other = http.createServer(handle);
  secure = https.createServer({ key: tls("localhost.key"), cert: tls("localhost.pem") }, handle);
  wrong = https.createServer({ key: tls("wrong.key"), cert: tls("wrong.pem") }, handle);
  base = `http://127.0.0.1:${await listen(plain)}`;
  otherBase = `http://127.0.0.1:${await listen(other)}`;
  secureBase = `https://localhost:${await listen(secure)}`;
  wrongBase = `https://localhost:${await listen(wrong)}`;

  routes.set("/resumed", (req, res) => res.writeHead(200).end(String((req.socket as TLSSocket).isSessionReused())));
  routes.set("/ok", (_, res) => res.writeHead(200, { "content-type": "text/plain" }).end("all good here"));
  routes.set("/json", (_, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", db: { ok: true, latency_ms: 42 } })));
  // A body some servers write with a UTF-8 byte-order mark first (PowerShell, .NET's StreamWriter).
  routes.set("/bom", (_, res) => res.writeHead(200, { "content-type": "application/json" }).end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"status":"ok"}')])));
  routes.set("/whoami", (_, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: "ana@example.com", key: "abc123xyz" })));
  routes.set("/leaky", (_, res) => res.writeHead(500).end('{"error":"boom","token":"abc123","auth":"Bearer zzz.yyy"}'));
  routes.set("/slow", (_, res) => setTimeout(() => res.writeHead(200).end("late"), 60));
  routes.set("/hang", () => {});
  routes.set("/big", (_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[" + '"xxxxxxxxxx",'.repeat(10_000) + '"end"]');
  });
  routes.set("/echo-method", (req, res, body) => res.writeHead(200).end(`${req.method} ${body}`));
  routes.set("/loop", (_, res) => res.writeHead(302, { location: "/loop" }).end());
  routes.set("/to-ok", (_, res) => res.writeHead(301, { location: "/ok" }).end());
  routes.set("/to-other", (_, res) => res.writeHead(302, { location: `${otherBase}/ok` }).end());
  routes.set("/to-same", (_, res) => res.writeHead(307, { location: "/ok" }).end());
  routes.set("/see-other", (_, res) => res.writeHead(303, { location: "/echo-method" }).end());
  routes.set("/to-private", (_, res) => res.writeHead(302, { location: `http://127.0.0.2:1/ok` }).end());
  routes.set("/to-file", (_, res) => res.writeHead(302, { location: "file:///etc/passwd" }).end());
  routes.set("/to-nowhere", (_, res) => res.writeHead(302, { location: "http://[" }).end());
  routes.set("/waf", (_, res) => res.writeHead(200, { "x-amzn-waf-action": "challenge", "content-type": "text/html" }).end("<html>Checking your browser</html>"));
  routes.set("/to-waf", (_, res) => res.writeHead(302, { location: "/waf" }).end());
  routes.set("/accepted", (_, res) => res.writeHead(202).end());
  routes.set("/full-imperva", (_, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<html><script src="/_Incapsula_Resource?x=1"></script>${"<p>Real page</p>".repeat(100)}</html>`));
});

afterAll(async () => {
  for (const s of [plain, other, secure, wrong]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const get = (url: string, extra: Partial<HttpCheck> = {}): HttpCheck => ({ url, method: "GET", expect: "2xx", slowMs: 5000, timeoutSec: 5, ...extra });

describe("statusMatches", () => {
  it("reads 2xx, 3xx and one exact code", () => {
    expect(statusMatches("2xx", 204)).toBe(true);
    expect(statusMatches("2xx", 301)).toBe(false);
    expect(statusMatches("3xx", 302)).toBe(true);
    expect(statusMatches("404", 404)).toBe(true);
    expect(statusMatches("404", 200)).toBe(false);
  });
});

describe("checkHttp", () => {
  // Owner, 2026-10-24: a running monitor goes down on a bot challenge instead of staying green.
  it("fails a bot challenge in the final answer, whatever status it carries", async () => {
    for (const path of ["/waf", "/to-waf"]) {
      const r = await checkHttp(get(`${base}${path}`), { allow });
      expect(r).toMatchObject({ ok: false, status: 200, failure: { kind: "status", message: BOT_PROTECTION } });
    }
    expect(await checkHttp(get(`${base}/accepted`), { allow })).toMatchObject({ ok: false, failure: { message: BOT_PROTECTION } });
  });
  it("passes an empty 202 to a POST and a full page that loads Imperva", async () => {
    expect(await checkHttp({ ...get(`${base}/accepted`, { expect: "202" }), method: "POST", body: "{}" }, { allow })).toMatchObject({ ok: true, status: 202 });
    expect(await checkHttp(get(`${base}/full-imperva`), { allow })).toMatchObject({ ok: true });
  });
  it("passes a 2xx with the keyword, and says who asked", async () => {
    const r = await checkHttp(get(`${base}/ok`, { keyword: "good" }), { allow });
    expect(r).toMatchObject({ ok: true, status: 200, slow: false, address: "127.0.0.1" });
    expect(r.timings?.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(seen.at(-1)?.headers["user-agent"]).toBe(USER_AGENT);
    expect(seen.at(-1)?.headers.cookie).toBeUndefined();
  });

  // What `/bot` and `/legal/privacy` say: a stored header is sent as stored and replaces the
  // check's own of the same name, whatever its case, and a cookie goes only if one was stored.
  it("sends a builder's headers as stored, over its own User-Agent and Accept", async () => {
    await checkHttp(get(`${base}/ok`, { headers: { "User-Agent": "TheirMonitor/2", Accept: "text/plain", Cookie: "session=abc" } }), { allow });
    const h = seen.at(-1)?.headers ?? {};
    expect(h["user-agent"]).toBe("TheirMonitor/2");
    expect(h.accept).toBe("text/plain");
    expect(h.cookie).toBe("session=abc");
  });

  it("refuses loopback under the default guard, before connecting", async () => {
    const before = seen.length;
    const r = await checkHttp(get(`${base}/ok`));
    expect(r.failure?.kind).toBe("private");
    expect(seen.length).toBe(before);
    expect((await checkHttp(get("http://localhost:1/"))).failure?.kind).toBe("private");
  });

  it("refuses a name that resolves to an address the guard rejects (checked after resolution)", async () => {
    const r = await checkHttp(get(`http://localhost:${new URL(base).port}/ok`), { allow: () => false });
    expect(r.failure).toMatchObject({ kind: "private" });
    expect(r.failure?.message).toMatch(/resolved to a private address/);
  });

  it("fails a missing keyword with a masked snippet", async () => {
    const r = await checkHttp(get(`${base}/ok`, { keyword: "nope" }), { allow });
    expect(r).toMatchObject({ ok: false, status: 200, failure: { kind: "keyword" }, snippet: "all good here" });
  });

  it("fails the wrong status, and masks what the body echoes", async () => {
    const r = await checkHttp(get(`${base}/leaky`, { headers: { "x-api-key": "abc123" } }), { allow });
    expect(r.failure).toEqual({ kind: "status", message: "Answered 500, expected 2xx" });
    expect(r.snippet).toBe('{"error":"boom","token":"•••","auth":"Bearer •••"}');
    expect(r.snippet).not.toContain("abc123");
  });

  it("fails, rather than throws, on a header value Node won't send, and never echoes the value", async () => {
    const r = await checkHttp(get(`${base}/ok`, { headers: { "x-api-key": "“secret-value”" } }), { allow });
    expect(r).toMatchObject({ ok: false, failure: { kind: "protocol" } });
    expect(r.failure?.message).toMatch(/^Couldn't send the request/);
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("masks what a failed assertion got, in the result and in the sentence", async () => {
    const r = await checkHttp(
      get(`${base}/whoami`, { headers: { "x-api-key": "abc123xyz" }, assertions: [{ path: "$.user", op: "==", value: "bot" }, { path: "$.key", op: "==", value: "k" }] }),
      { allow },
    );
    expect(r.failure).toEqual({ kind: "assertion", message: '$.user == bot failed: got "•••"' });
    expect(r.assertions?.map((a) => a.got)).toEqual(['"•••"', '"•••"']);
  });

  it("judges assertions on a JSON body", async () => {
    const good = await checkHttp(get(`${base}/json`, { assertions: [{ path: "$.db.ok", op: "==", value: "true" }] }), { allow });
    expect(good.ok).toBe(true);
    expect(good.assertions?.[0].pass).toBe(true);
    const bad = await checkHttp(get(`${base}/json`, { assertions: [{ path: "$.db.latency_ms", op: "<", value: "10" }] }), { allow });
    expect(bad.failure).toEqual({ kind: "assertion", message: "$.db.latency_ms < 10 failed: got 42" });
    const missing = await checkHttp(get(`${base}/json`, { assertions: [{ path: "$.cache.ok", op: "exists", value: "" }] }), { allow });
    expect(missing.failure?.message).toBe("$.cache.ok exists failed: nothing there");
    const notJson = await checkHttp(get(`${base}/ok`, { assertions: [{ path: "$.a", op: "exists", value: "" }] }), { allow });
    expect(notJson.failure).toEqual({ kind: "assertion", message: "The body isn't JSON" });
  });

  it("reads JSON that starts with a byte-order mark, as the suggestions and the dashboard's test do", async () => {
    const assertions = [{ path: "$.status", op: "==" as const, value: "ok" }];
    const r = await checkHttp(get(`${base}/bom`, { assertions }), { allow });
    expect(r.ok).toBe(true);
    expect(r.assertions?.[0].pass).toBe(true);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"status":"ok"}')]);
    expect(healthJson(bom, false)).toEqual({ status: "ok" });
    expect(bodyText(bom)).toBe('{"status":"ok"}');
  });

  it("reads at most 64 KB, and says so when that breaks the JSON", async () => {
    const r = await checkHttp(get(`${base}/big`, { assertions: [{ path: "$[0]", op: "exists", value: "" }] }), { allow });
    expect(r.failure).toEqual({ kind: "assertion", message: "The body is over 64 KB, so it can't be read as JSON" });
    expect(Buffer.byteLength(r.snippet ?? "")).toBeLessThanOrEqual(300);
  });

  it("marks a pass over the slow threshold", async () => {
    const r = await checkHttp(get(`${base}/slow`, { slowMs: 20 }), { allow });
    expect(r).toMatchObject({ ok: true, slow: true });
  });

  it("times out a server that never answers", async () => {
    const r = await checkHttp(get(`${base}/hang`, { timeoutSec: 1 }), { allow });
    expect(r.failure).toEqual({ kind: "timeout", message: "No answer within 1 s" });
    expect(r.ms).toBeGreaterThanOrEqual(900);
  });

  it("calls a closed port refused", async () => {
    const r = await checkHttp(get("http://127.0.0.1:1/"), { allow });
    expect(r.failure).toEqual({ kind: "connect", message: "Connection refused" });
  });

  it("calls an address it can't parse a protocol failure", async () => {
    expect((await checkHttp(get("not a url"), { allow })).failure?.kind).toBe("protocol");
  });

  describe("redirects", () => {
    it("follows them to the final answer", async () => {
      const r = await checkHttp(get(`${base}/to-ok`, { keyword: "good" }), { allow });
      expect(r).toMatchObject({ ok: true, status: 200 });
    });

    it("stops after 5", async () => {
      const r = await checkHttp(get(`${base}/loop`), { allow });
      expect(r.failure).toEqual({ kind: "redirects", message: "More than 5 redirects" });
    });

    it("doesn't follow when the builder expects a 3xx", async () => {
      const r = await checkHttp(get(`${base}/to-ok`, { expect: "3xx" }), { allow });
      expect(r).toMatchObject({ ok: true, status: 301 });
    });

    it("judges the body with the monitor's own secrets hidden, so a guess at an echoed header never passes", async () => {
      routes.set("/echo-key", (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seen: req.headers["x-api-key"], ok: true })));
      const headers = { "x-api-key": "Sup3rSecretValue_42" };
      const guess = await checkHttp(get(`${base}/echo-key`, { headers, assertions: [{ path: "$.seen", op: "contains", value: "Sup3r" }] }), { allow });
      expect(guess.ok).toBe(false);
      expect((await checkHttp(get(`${base}/echo-key`, { headers, keyword: "Value_42" }), { allow })).ok).toBe(false);
      expect((await checkHttp(get(`${base}/echo-key`, { headers, assertions: [{ path: "$.ok", op: "==", value: "true" }] }), { allow })).ok).toBe(true);
    });

    it("judges an echo however its JSON escapes it, and a secret that looks like JSON never breaks the body", async () => {
      // PHP's json_encode writes "/" as "\/".
      routes.set("/echo-escaped", (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(`{"seen":"${String(req.headers["x-api-key"]).replaceAll("/", "\\/")}","count":1234,"ok":true}`));
      const slashed = { "x-api-key": "Sup3r/Secret/42" };
      expect((await checkHttp(get(`${base}/echo-escaped`, { headers: slashed, assertions: [{ path: "$.seen", op: "contains", value: "Sup3r" }] }), { allow })).ok).toBe(false);
      expect((await checkHttp(get(`${base}/echo-escaped`, { headers: slashed, keyword: "Secret" }), { allow })).ok).toBe(false);
      const looksLikeJson = { "x-api-key": "1234" };
      expect((await checkHttp(get(`${base}/echo-escaped`, { headers: looksLikeJson, assertions: [{ path: "$.ok", op: "==", value: "true" }] }), { allow })).ok).toBe(true);
    });

    it("sends secret headers to their own origin only", async () => {
      await checkHttp(get(`${base}/to-same`, { headers: { authorization: "Bearer same-origin" } }), { allow });
      expect(seen.at(-1)).toMatchObject({ path: "/ok" });
      expect(seen.at(-1)?.headers.authorization).toBe("Bearer same-origin");
      await checkHttp(get(`${base}/to-other`, { headers: { authorization: "Bearer cross-origin" } }), { allow });
      expect(seen.at(-1)).toMatchObject({ path: "/ok" });
      expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    });

    it("turns a POST into a GET on 303, dropping the body", async () => {
      const r = await checkHttp({ ...get(`${base}/see-other`, { keyword: "GET " }), method: "POST", body: "payload" }, { allow });
      expect(r.ok).toBe(true);
      expect(seen.at(-1)?.method).toBe("GET");
    });

    it("asks the guard again at every hop", async () => {
      const r = await checkHttp(get(`${base}/to-private`), { allow: (a) => a === "127.0.0.1" });
      expect(r.failure).toEqual({ kind: "private", message: "A redirect led to 127.0.0.2 is a private address" });
    });

    it("refuses a redirect off HTTP", async () => {
      const r = await checkHttp(get(`${base}/to-file`), { allow });
      expect(r.failure?.kind).toBe("redirects");
    });

    it("fails a redirect to an address that can't be parsed, saying so, instead of throwing", async () => {
      const r = await checkHttp(get(`${base}/to-nowhere`), { allow });
      expect(r.failure).toEqual({ kind: "redirects", message: "The redirect's Location isn't a valid address" });
      expect(r.status).toBe(302);
    });
  });

  describe("TLS", () => {
    it("passes a certificate its CA vouches for", async () => {
      const r = await checkHttp(get(`${secureBase}/ok`), { allow, ca: tls("ca.pem") });
      expect(r).toMatchObject({ ok: true, status: 200 });
      expect(r.timings?.tlsMs).toBeGreaterThanOrEqual(0);
    });

    it("makes a full handshake every check, never resuming a session", async () => {
      for (let i = 0; i < 3; i++) {
        const r = await checkHttp(get(`${secureBase}/resumed`, { keyword: "false" }), { allow, ca: tls("ca.pem") });
        expect(r.ok).toBe(true);
      }
    });

    it("fails a chain nobody vouches for", async () => {
      const r = await checkHttp(get(`${secureBase}/ok`), { allow });
      expect(r.failure?.kind).toBe("tls");
    });

    it("fails a certificate for another name", async () => {
      const r = await checkHttp(get(`${wrongBase}/ok`), { allow, ca: tls("ca.pem") });
      expect(r.failure?.kind).toBe("tls");
    });
  });
});
