import { expect, it, vi } from "vitest";
import { vercelCrons, netlifyCrons } from "../../packages/staygreen/src/crons";
import { call } from "../../packages/staygreen/src/client";
it("reads cron definitions without executing repository code and refuses ambiguous schedules", () => {
  expect(vercelCrons('{"crons":[{"path":"/api/cleanup","schedule":"0 0 * * *"}],"other":"ignored"}')).toEqual([{ name: "/api/cleanup", schedule: "0 0 * * *", tz: "UTC" }]);
  expect(netlifyCrons('[build]\ncommand = "never executed"\n[functions."cleanup"]\nschedule = "0 0 * * *" # daily')).toEqual([{ name: "cleanup", schedule: "0 0 * * *", tz: "UTC" }]);
  expect(() => netlifyCrons('schedule = "0 * * * *"')).toThrow();
  expect(() => netlifyCrons('[functions."job"]\nschedule = "0 * * * *"\nschedule = "1 * * * *"')).toThrow();
  expect(() => vercelCrons('{"crons":[{"path":"/api/job"}]}')).toThrow();
});
it("uses the anonymous scan endpoint, explicit bearer for provision, no redirects and the same request id", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ created: true }));
  await call("https://staygreen.test", "scan_app", { url: "https://example.com" }, undefined, fetcher);
  expect(String(fetcher.mock.calls[0][0])).toBe("https://staygreen.test/api/scan"); expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  await call("https://staygreen.test", "provision_app", { request_id: "fixed" }, "sg_secret", fetcher);
  expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer sg_secret" }, body: '{"request_id":"fixed"}' });
});
it("does not leak error bodies, refuses insecure origins and bounds response size", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret", { status: 401 }));
  await expect(call("https://staygreen.test", "scan_app", {}, undefined, fetcher)).rejects.not.toThrow("secret");
  await expect(call("http://remote.test", "scan_app", {}, undefined, fetcher)).rejects.toThrow("HTTPS");
  fetcher.mockResolvedValue(new Response("x".repeat(262145))); await expect(call("https://staygreen.test", "scan_app", {}, undefined, fetcher)).rejects.toThrow("256 KiB");
});
