import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { RedirectCookies } from "@/checks/redirect-cookies";
import { checkHttp, type Observed } from "@/checks/http";
import { USER_AGENT } from "@/checks/types";
import { BOT_PROTECTION } from "@/lib/bot-protection";

afterEach(() => vi.restoreAllMocks());
const url = (s: string) => new URL(s);
it("honours host-only, Domain, Path boundaries, Secure, expiry and replacement", () => {
  const jar = new RedirectCookies();
  const at = url("https://auth.example.co.uk/login/start");
  jar.receive(at, ["host=one", "shared=two; Domain=.example.co.uk; Path=/; Secure", "narrow=three; Path=/login", "expired=gone; Max-Age=0", "epoch=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT"], 1000);
  expect(jar.header(url("https://auth.example.co.uk/login/next"), 1000)).toBe("host=one; narrow=three; shared=two");
  expect(jar.header(url("https://app.example.co.uk/"), 1000)).toBe("shared=two");
  expect(jar.header(url("https://auth.example.co.uk/logins"), 1000)).toBe("shared=two");
  expect(jar.header(url("http://app.example.co.uk/"), 1000)).toBe("");
  expect(jar.header(url("https://notexample.co.uk/"), 1000)).toBe("");
  jar.receive(at, ["shared=new; Domain=example.co.uk; Path=/; Secure; Max-Age=1"], 1000);
  expect(jar.header(url("https://app.example.co.uk/"), 1999)).toBe("shared=new");
  expect(jar.header(url("https://app.example.co.uk/"), 2000)).toBe("");
});
it("refuses unrelated/public/private suffix domains and invalid secure prefixes", () => {
  const jar = new RedirectCookies();
  jar.receive(url("https://alice.github.io/"), ["bad=a; Domain=github.io", "bad=b; Domain=bob.github.io", "__Host-id=c; Secure; Domain=alice.github.io", "__Secure-id=d", "ok=e; Domain=alice.github.io; Secure"]);
  expect(jar.header(url("https://alice.github.io/"))).toBe("ok=e");
  expect(jar.header(url("https://bob.github.io/"))).toBe("");
  jar.receive(url("http://alice.github.io/"), ["ok=overwrite; Domain=alice.github.io", "new=x; Secure"]);
  expect(jar.header(url("https://alice.github.io/"))).toBe("ok=e");
});
it("completes a cookie-gated redirect chain, keeps cookies within one check, masks Set-Cookie, and preserves stored Accept", async () => {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const request = ((address: URL, opts: { headers: Record<string, string> }) => {
    sent.push({ url: address.href, headers: opts.headers });
    const req = new EventEmitter();
    return Object.assign(req, { end() {
      let status = 200, body = "ok"; const headers: Record<string, string | string[]> = {};
      if (address.pathname === "/start") { status = 302; headers["set-cookie"] = ["redirect_session=temporarySecret; Secure; Path=/"]; headers.location = "/next"; }
      if (address.pathname === "/next") { status = opts.headers.cookie === "redirect_session=temporarySecret" ? 200 : 302; headers.location = "/start"; body = "temporarySecret"; }
      req.emit("response", Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers }));
    }, destroy() {} });
  }) as typeof http.request;
  vi.spyOn(http, "request").mockImplementation(request); vi.spyOn(https, "request").mockImplementation(request);
  const c = { url: "https://example.com/start", method: "GET" as const, expect: "2xx", slowMs: 1000 };
  const seen: Observed[] = [];
  expect((await checkHttp(c, { observe: r => seen.push(r) })).ok).toBe(true);
  expect(sent.map(s => s.url)).toEqual(["https://example.com/start", "https://example.com/next"]);
  expect(sent[0].headers).toMatchObject({ accept: "*/*", "user-agent": USER_AGENT });
  expect(JSON.stringify(seen.map(s => s.headers))).not.toContain("temporarySecret");
  expect(seen[1].body.toString()).toBe("temporarySecret"); // the body as the site sent it
  await checkHttp({ ...c, url: "https://example.com/other", headers: { Accept: "application/health+json", Cookie: "chosen=explicit" } });
  expect(sent[2].headers).toMatchObject({ accept: "application/health+json", cookie: "chosen=explicit" });
  await checkHttp({ ...c, url: "https://example.com/other" });
  expect(sent[3].headers.cookie).toBeUndefined();
});
it("turns a running monitor down on a bot challenge (owner, 2026-10-24)", async () => {
  const request = (() => {
    const req = new EventEmitter();
    return Object.assign(req, { end() { req.emit("response", Object.assign(Readable.from([]), { statusCode: 202, headers: { "x-amzn-waf-action": "challenge" } })); }, destroy() {} });
  }) as unknown as typeof https.request;
  vi.spyOn(https, "request").mockImplementation(request);
  expect(await checkHttp({ url: "https://example.com/", method: "GET", expect: "2xx", slowMs: 1000 })).toMatchObject({ ok: false, failure: { message: BOT_PROTECTION } });
});

it("judges and observes the body as sent, whatever short cookies the site sets (review 109)", async () => {
  let answer = { body: Buffer.from([137, 80, 78, 71, 0, 255, ...Buffer.from("https")]), type: "image/png" };
  const request = (() => {
    const req = new EventEmitter();
    return Object.assign(req, { end() { req.emit("response", Object.assign(Readable.from([answer.body]), { statusCode: 200, headers: { "content-type": answer.type, "set-cookie": ["x=https", "lang=en", "consent=1", "variant=a", "rejected=foreignValue; Domain=evil.test"] } })); }, destroy() {} });
  }) as unknown as typeof https.request;
  vi.spyOn(https, "request").mockImplementation(request);
  const seen: Observed[] = [];
  const c = { url: "https://example.com/", method: "GET" as const, expect: "2xx", slowMs: 1000 };
  await checkHttp(c, { observe: r => seen.push(r) });
  expect(seen[0].body).toEqual(answer.body);
  expect(seen[0].url).toBe(c.url);
  expect(seen[0].headers["set-cookie"]).toEqual(["x=•••", "lang=•••", "consent=•••", "variant=•••", "rejected=•••; Domain=evil.test"]);
  // A healthy answer stays healthy: `en` inside the keyword, `1` inside a number, `a` inside a key.
  answer = { body: Buffer.from('{"status":"ok","latency_ms":120,"docs":"Documentation"}'), type: "application/json" };
  const r = await checkHttp({ ...c, keyword: "Documentation", assertions: [{ path: "$.status", op: "==", value: "ok" }, { path: "$.latency_ms", op: "<", value: "500" }] }, { observe: r => seen.push(r) });
  expect(r).toMatchObject({ ok: true });
  expect(seen[1].body.toString()).toBe(answer.body.toString());
});
