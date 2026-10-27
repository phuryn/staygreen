import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { checkHttp } from "@/checks/http";
import { runScan, scanDependencies } from "@/lib/scan";

// Run the real scan and HTTP redirect loop; fake only Node's request boundary so an
// accidentally admitted destination is recorded, never contacted. DNS has its own suite.
function transport(locations: string[]) {
  const requested: string[] = [];
  const request = ((url: URL) => {
    requested.push(url.href);
    const location = locations[requested.length - 1];
    const response = Object.assign(Readable.from([Buffer.from('<a href="/status">Status</a>')]), {
      statusCode: location ? 302 : 200, headers: location ? { location } : {},
    });
    const outgoing = new EventEmitter();
    return Object.assign(outgoing, {
      end() { outgoing.emit("response", response); },
      destroy() { response.destroy(); },
    });
  }) as typeof http.request;
  vi.spyOn(http, "request").mockImplementation(request);
  vi.spyOn(https, "request").mockImplementation(request);
  return requested;
}
const scan = () => runScan({ url: "http://app.example.com/start" }, {
  ...scanDependencies,
  cert: vi.fn(async () => ({ ok: true, ms: 1 })),
  rdapFetch: vi.fn(async () => ({ error: "No answer" })),
  dns: vi.fn(async () => []),
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["HTTPS port", "https://other.example.com:8443/path"], ["HTTP port", "http://other.example.com:8080/path"],
  ["userinfo", "https://user:secret@other.example.com/path"], ["scheme-relative userinfo", "//user:secret@other.example.com/path"],
  ["query", "https://other.example.com/path?key=secret"], ["relative query", "?key=secret"], ["fragment", "#fragment"],
  ["protocol", "ftp://other.example.com/path"], ["localhost", "http://localhost/path"], ["local name", "http://metadata.internal/path"],
  ["private IPv4", "http://10.0.0.1/path"], ["loopback IPv6", "http://[::1]/path"], ["mapped IPv4", "http://[::ffff:127.0.0.1]/path"],
  ["oversized URL", "/" + "x".repeat(2048)],
])("refuses a later scan redirect before requesting it: %s", async (_reason, location) => {
  const requested = transport(["https://next.example.com/allowed", location]);
  const result = await scan();
  expect(requested).toEqual(["http://app.example.com/start", "https://next.example.com/allowed"]);
  expect(result.status_page.state).toBe("unknown");
});

it("follows admissible scan redirects across hosts, paths, schemes and ports 80/443", async () => {
  const requested = transport(["/next", "https://next.example.com:443/app", "http://last.example.com:443/final", "https://last.example.com:80/final"]);
  const result = await scan();
  expect(requested).toEqual(["http://app.example.com/start", "http://app.example.com/next", "https://next.example.com/app", "http://last.example.com:443/final", "https://last.example.com:80/final"]);
  expect(result.status_page).toMatchObject({ state: "found", url: "https://last.example.com:80/status" });
});

it("still follows a builder's monitor redirects to other public ports and query strings", async () => {
  const destination = "https://other.example.com:8443/health?region=eu";
  const requested = transport([destination]);
  const result = await checkHttp({ url: "http://app.example.com/start", method: "GET", expect: "2xx", slowMs: 5000 });
  expect(result.ok).toBe(true);
  expect(requested).toEqual(["http://app.example.com/start", destination]);
});
