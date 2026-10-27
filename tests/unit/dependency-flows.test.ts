import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runScan, scanDependencies } from "@/lib/scan";
import { runSuggestions } from "@/lib/suggestion-checks";
vi.mock("@/checks/cert", () => ({ checkCert: vi.fn(async () => ({ ok: true, ms: 1 })) }));
const app = "https://askone.org/";
const script = "https://clerk.askone.org/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
const key = "pk_live_" + Buffer.from("clerk.askone.org$").toString("base64");
const html = `<script data-clerk-publishable-key="${key}" src="${script}"></script>`;
type Answer = { status?: number; body?: string; headers?: Record<string, string>; error?: string };
function transport(scriptAnswer: Answer) {
  const requested: string[] = [];
  const request = ((url: URL) => {
    requested.push(url.href);
    const answer: Answer = url.href === app ? { status: 200, body: html, headers: { "content-type": "text/html" } } : url.href === script ? scriptAnswer : { status: 404 };
    const req = new EventEmitter();
    return Object.assign(req, { end() {
      if (answer.error) { req.emit("error", Object.assign(Error("Not found"), { code: answer.error })); return; }
      req.emit("response", Object.assign(Readable.from([Buffer.from(answer.body ?? "")]), { statusCode: answer.status ?? 200, headers: answer.headers ?? {} }));
    }, destroy() {} });
  }) as typeof http.request;
  vi.spyOn(http, "request").mockImplementation(request); vi.spyOn(https, "request").mockImplementation(request);
  return requested;
}
const dns = vi.fn(async (_server: string, _name: string, record: string) => record === "NS" ? ["ns1.example.net", "ns2.example.net"] : ["frontend.clerk.services"]);
const scan = () => runScan({ url: app }, { ...scanDependencies, dns, rdapFetch: vi.fn(async () => ({ error: "No answer" })) });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("reproduces AskOne: app 200 and good certificate, but the sign-in host no longer resolves", async () => {
  const requested = transport({ error: "ENOTFOUND" });
  const result = await scan();
  expect(result.certificate.state).toBe("ok");
  expect(result.dependencies.checks).toMatchObject([{ provider: "Clerk", host: "clerk.askone.org", dns: "issue", tls: "unknown", frontend: "issue" }]);
  expect(result.dependencies.dns.map(d => d.record)).toEqual(["NS", "CNAME"]);
  expect(requested).toEqual([app, script]); expect(JSON.stringify(result)).not.toContain(key);
});
it("offers the same frontend keyword and DNS checks in suggestions and the scan", async () => {
  const requested = transport({ body: "window.Clerk = {};", headers: { "content-type": "application/javascript" } });
  const result = await scan();
  const suggestions = await runSuggestions(app, 25000, false, { dns });
  expect(result.dependencies.checks[0]).toMatchObject({ dns: "ok", tls: "ok", frontend: "ok", keyword: "Clerk" });
  expect(suggestions?.http).toContainEqual(expect.objectContaining({ url: script, dependency: "Clerk", keyword: "Clerk", ticked: true, ok: true }));
  expect(suggestions?.dns).toEqual(result.dependencies.dns);
  expect(requested.filter(u => u === script)).toHaveLength(2);
});
it.each(["https://public.example.com:8443/script.js", "https://user:pass@public.example.com/script.js", "https://public.example.com/script.js?key=secret", "http://127.0.0.1/script.js"])("applies scan entry rules to a dependency redirect: %s", async location => {
  const requested = transport({ status: 302, headers: { location } });
  const result = await scan();
  expect(requested).toEqual([app, script]); expect(result.dependencies.checks[0]).toMatchObject({ dns: "ok", tls: "ok", frontend: "issue" });
});
it("does not tick a 200 HTML error page in place of the Clerk script", async () => {
  transport({ body: "<html>Temporarily unavailable</html>", headers: { "content-type": "text/html" } });
  const suggestions = await runSuggestions(app, 25000, false, { dns });
  expect(suggestions?.http.find(h => h.url === script)).toMatchObject({ ticked: false, ok: false, keyword: "Clerk" });
});
