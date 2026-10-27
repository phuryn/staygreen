import { describe, expect, it, vi } from "vitest";
import { inspect, config, telegram, type Receipt, type FlushStatus } from "../../watchdog/check";
import worker, { Watchdog } from "../../watchdog/worker";

function rig() {
  const saved = new Map<string, Receipt>();
  const receipts = { get: async (key: string) => saved.get(key), put: async (key: string, v: Receipt) => { saved.set(key, v); } };
  const send = vi.fn(async (_s: string) => true);
  let now = 1_000_000;
  let rows: FlushStatus[] = [{ id: "tor1-a", age_sec: 599, flushed_at: new Date() }, { id: "sfo3-a", age_sec: null, flushed_at: null }];
  const read = vi.fn(async () => rows);
  const deps = { receipts, send, read, now: () => now };
  return { saved, deps, send, read, rows, setRows: (v: FlushStatus[]) => { rows = v; }, advance: (ms: number) => { now += ms; } };
}
const ids = ["tor1-a", "sfo3-a"];

describe("independent dead-man switch", () => {
  it("alerts for never-started and 600-second stale probes, not 599 seconds", async () => {
    const r = rig();
    await inspect(ids, r.deps);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.send.mock.calls[0][0]).toBe("Staygreen: the San Francisco probe (sfo3-a) hasn't sent its numbers yet. Still sending: Toronto. Check: npm run ops -- status");
    r.rows[0].age_sec = 600;
    await inspect(ids, r.deps);
    expect(r.send).toHaveBeenCalledTimes(2);
    // 1_000_000 ms is 00:16:40 UTC on 1 Jan 1970; 600 s earlier is 00:06.
    expect(r.send.mock.calls[1][0]).toBe("Staygreen: the Toronto probe (tor1-a) hasn't sent its numbers since 00:06 UTC, 10 minutes ago. " +
      "No probe is sending, so monitors may not be checked at all. " +
      "Check: npm run ops -- status");
    expect(r.send.mock.calls[1][0]).not.toMatch(/rollup|Event|flush/);
  });
  it("names the other city when one probe is stale and the other is sending", async () => {
    const r = rig();
    r.setRows([
      { id: "tor1-a", age_sec: 600, flushed_at: new Date(400_000) },
      { id: "sfo3-a", age_sec: 599, flushed_at: new Date(401_000) },
    ]);
    await inspect(ids, r.deps);
    expect(r.send.mock.calls).toEqual([["Staygreen: the Toronto probe (tor1-a) hasn't sent its numbers since 00:06 UTC, 10 minutes ago. Still sending: San Francisco. Check: npm run ops -- status"]]);
  });
  it("names only fresh peers, without inferring takeover or lost monitor results", async () => {
    const r = rig();
    r.setRows([
      { id: "tor1-a", age_sec: 600, flushed_at: new Date(400_000) },
      { id: "sfo3-a", age_sec: 599, flushed_at: new Date(401_000) },
      { id: "fra1-a", age_sec: 1, flushed_at: new Date(999_000) },
      { id: "tor1-b", age_sec: 600, flushed_at: new Date(400_000) },
    ]);
    await inspect([...ids, "fra1-a", "tor1-b"], r.deps);
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(r.send.mock.calls[0][0]).toBe("Staygreen: the Toronto probe (tor1-a) hasn't sent its numbers since 00:06 UTC, 10 minutes ago. " +
      "Still sending: San Francisco, Frankfurt. Check: npm run ops -- status");
    expect(r.send.mock.calls[1][0]).toContain("Still sending: San Francisco, Frankfurt.");
  });
  it("warns for every probe when the whole expected fleet is stale", async () => {
    const r = rig();
    r.setRows(ids.map((id) => ({ id, age_sec: 600, flushed_at: new Date(400_000) })));
    await inspect(ids, r.deps);
    expect(r.send.mock.calls.map(([message]) => message)).toEqual([
      "Staygreen: the Toronto probe (tor1-a) hasn't sent its numbers since 00:06 UTC, 10 minutes ago. No probe is sending, so monitors may not be checked at all. Check: npm run ops -- status",
      "Staygreen: the San Francisco probe (sfo3-a) hasn't sent its numbers since 00:06 UTC, 10 minutes ago. No probe is sending, so monitors may not be checked at all. Check: npm run ops -- status",
    ]);
  });
  it.each([600, null])("warns when the only expected probe has no fresh receipt (%s)", async (age) => {
    const r = rig();
    r.setRows([{ id: "tor1-a", age_sec: age, flushed_at: age === null ? null : new Date(400_000) }]);
    await inspect(["tor1-a"], r.deps);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.send.mock.calls[0][0]).toContain("No probe is sending, so monitors may not be checked at all.");
    expect(r.send.mock.calls[0][0]).not.toContain("Still sending:");
  });
  it("persists receipts across runs, repeats after 30 minutes and sends one recovery", async () => {
    const r = rig();
    await inspect(ids, r.deps);
    r.advance(1_799_999);
    await inspect(ids, { ...r.deps });
    expect(r.send).toHaveBeenCalledTimes(1);
    r.advance(1);
    await inspect(ids, r.deps);
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(r.saved.get("receipt:sfo3-a")).toEqual({ state: "stale", at: 2_800_000, event: "sfo3-a:1000000" });
    r.rows[1].age_sec = 1;
    r.rows[1].flushed_at = new Date(2_799_000);
    await inspect(ids, r.deps);
    await inspect(ids, r.deps);
    expect(r.send).toHaveBeenCalledTimes(3);
    expect(r.send.mock.calls[2][0]).toBe("Staygreen: the San Francisco probe (sfo3-a) is sending its numbers again. It was first flagged at 00:16 UTC, 30 minutes ago. Check: npm run ops -- status");
    r.rows[1].age_sec = 600;
    await inspect(ids, r.deps);
    expect(r.send).toHaveBeenCalledTimes(4);
    r.rows[1].age_sec = 1;
    await inspect(ids, r.deps);
    expect(r.send.mock.calls[4][0]).toContain("It was first flagged at 00:46 UTC, less than a minute ago.");
  });
  it("dates a recovery that comes a day or more after the first flag by its age", async () => {
    const r = rig();
    await inspect(ids, r.deps);
    r.advance(26 * 3_600_000);
    r.rows[1].age_sec = 1;
    r.rows[1].flushed_at = new Date(1_000_000 + 26 * 3_600_000);
    await inspect(ids, r.deps);
    expect(r.send.mock.calls.at(-1)![0]).toContain("It was first flagged at 00:16 UTC, 26 hours ago.");
  });
  it("says 1 minute, not 1 minutes, for a recovery a minute after the flag", async () => {
    const r = rig();
    await inspect(ids, r.deps);
    r.advance(90_000);
    r.rows[1].age_sec = 1;
    r.rows[1].flushed_at = new Date(1_090_000);
    await inspect(ids, r.deps);
    expect(r.send.mock.calls.at(-1)![0]).toContain("It was first flagged at 00:16 UTC, 1 minute ago.");
  });
  it("does not mark a failed delivery sent, and retries it", async () => {
    const r = rig();
    r.send.mockResolvedValueOnce(false);
    await expect(inspect(ids, r.deps)).rejects.toThrow("retryable");
    expect(r.saved.size).toBe(0);
    await inspect(ids, r.deps);
    expect(r.saved.size).toBe(1);
  });
  it("alerts on a database failure or partial read and never declares the probes recovered", async () => {
    const r = rig();
    await inspect(ids, r.deps);
    r.read.mockRejectedValueOnce(new Error("secret database URL"));
    await inspect(ids, r.deps);
    expect(r.send.mock.calls[1][0]).toContain("can't read the probes' records");
    expect(r.send.mock.calls[1][0]).not.toContain("secret");
    r.setRows([]);
    await inspect(ids, r.deps);
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(r.saved.get("receipt:sfo3-a")?.state).toBe("stale");
  });
  it("refuses missing secrets and reports only field names", () => {
    expect(() => config({ TELEGRAM_BOT_TOKEN: "secret-here" })).toThrow("WATCHDOG_PROBES");
    expect(() => config({ TELEGRAM_BOT_TOKEN: "secret-here" })).not.toThrow("secret-here");
  });
  it("has no HTTP cron endpoint", () => { expect(worker.fetch().status).toBe(404); });
  it("fails a scheduled event when its object failed", async () => {
    const env = { WATCHDOG: { idFromName: () => "fleet", get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) } };
    await expect(worker.scheduled(null, env as never)).rejects.toThrow("scheduled run failed");
  });
  it("does not expose malformed environment details from the object", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const object = new Watchdog({ storage: rig().deps.receipts }, { TELEGRAM_BOT_TOKEN: "secret" } as never);
      expect((await object.fetch()).status).toBe(503);
      expect(error.mock.calls.flat().join(" ")).not.toContain("secret");
    } finally { error.mockRestore(); }
  });
});

describe("operator Telegram transport", () => {
  it.each([[200, '{"ok":true}', true], [200, '{"ok":false}', false], [429, "no", false]] as const)("requires HTTP and Telegram success (%s, %s)", async (status, body, expected) => {
    const request = vi.fn(async () => new Response(body, { status }));
    expect(await telegram("token", "-123", "message", request)).toBe(expected);
  });
  it("swallows credential-bearing network exceptions", async () => {
    expect(await telegram("secret", "-123", "message", async () => { throw new Error("https://api.telegram.org/botsecret"); })).toBe(false);
  });
});
