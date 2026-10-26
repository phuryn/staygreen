import { afterEach, expect, it, vi } from "vitest";
import { apiOrigin, call, ClientError } from "../src/client";

afterEach(() => vi.restoreAllMocks());
it.each(["http://remote.test", "https://user:secret@host.test", "https://host.test/path", "https://host.test?key=secret", "https://host.test#secret", "not-a-url"])("refuses invalid API origin %s before fetch", async origin => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(call(origin, "get_status", {}, "sg_secret", fetcher)).rejects.toThrow("HTTPS");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["http://localhost:3000", "http://127.0.0.1:3000", "https://selected.test"])("accepts the existing origin rule for %s", origin => {
  expect(apiOrigin(origin).origin).toBe(origin);
});
it.each(["//evil.test", "../other", "get_status?token=secret", "https://evil.test"])("refuses path manipulation %s", async operation => {
  const fetcher = vi.fn<typeof fetch>(); await expect(call("https://selected.test", operation, {}, "sg_secret", fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([429, 503])("retries HTTP %s once with the same body, origin, token and deadline", async status => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { code: "busy", message: "Wait" } }, { status, headers: { "Retry-After": "0" } }))
    .mockResolvedValueOnce(Response.json({ created: true }));
  const args = { request_id: "unchanged", name: "name" };
  await expect(call("https://selected.test", "provision_app", args, "sg_secret", fetcher)).resolves.toEqual({ created: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
});
it("does not retry again or wait longer than five seconds", async () => {
  const body = { error: { code: "rate_limited", message: "Wait", retry_after: 60 } };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status: 429, headers: { "Retry-After": "0" } }));
  await expect(call("https://selected.test", "get_status", {}, undefined, fetcher)).rejects.toMatchObject({ body });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockClear().mockResolvedValue(Response.json(body, { status: 429, headers: { "Retry-After": "6" } }));
  await expect(call("https://selected.test", "get_status", {}, undefined, fetcher)).rejects.toBeInstanceOf(ClientError);
  expect(fetcher).toHaveBeenCalledOnce();
});
it("aborts a retry wait without a second request", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503, headers: { "Retry-After": "5" } }));
  const pending = call("https://selected.test", "get_status", {}, undefined, fetcher, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ body: { error: { code: "request_cancelled" } } }); expect(fetcher).toHaveBeenCalledOnce();
});
it("enforces the 50-second deadline while a response body stalls", async () => {
  const timeout = new AbortController();
  const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  const cancelled = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })));
  const pending = call("https://selected.test", "get_status", {}, undefined, fetcher);
  await new Promise(resolve => setImmediate(resolve)); timeout.abort();
  await expect(pending).rejects.toThrow("50 seconds"); expect(deadline).toHaveBeenCalledWith(50_000); expect(cancelled).toHaveBeenCalledOnce();
});
it.each([401, 200])("never includes an invalid JSON HTTP %s body in an error", async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-not-json", { status }));
  await expect(call("https://selected.test", "get_status", {}, "sg_secret", fetcher)).rejects.not.toThrow("secret-not-json");
});
it("bounds and allowlists refusal fields after redacting credentials", async () => {
  const token = "sg_secret";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "plan_limit", message: token.repeat(200), details: { huge: "x".repeat(20000) }, retry_after: "untrusted", trace: "private" } }, { status: 409 }));
  try { await call("https://selected.test", "get_status", {}, token, fetcher); throw Error("Expected refusal"); }
  catch (e) {
    expect(e).toBeInstanceOf(ClientError);
    const body = (e as ClientError).body;
    expect(Object.keys(body.error)).toEqual(["code", "message"]); expect(body.error.message).toHaveLength(1000);
    expect(JSON.stringify(body)).not.toContain(token); expect(JSON.stringify(body)).not.toContain("private");
  }
});
it("refuses redirects instead of following Location with a bearer", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 302, headers: { Location: "https://evil.test/steal" } }));
  await expect(call("https://selected.test", "get_status", {}, "sg_secret", fetcher)).rejects.toThrow("HTTP 302");
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
});
