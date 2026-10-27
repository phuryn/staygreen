import { describe, expect, it, vi } from "vitest";
import { Canary, freshLookup } from "../../probe/canary";

describe("probe network canary", () => {
  it("tests the first failure and shares one bounded set across a burst", async () => {
    let now = 0;
    let release!: (v: boolean[]) => void;
    const check = vi.fn(() => new Promise<boolean[]>((r) => { release = r; }));
    const canary = new Canary(check, () => now);
    const checks = Array.from({ length: 50 }, () => canary.admitFailure());
    expect(check).toHaveBeenCalledTimes(1);
    release([true, false, true, false, true]);
    expect(await Promise.all(checks)).toEqual(Array(50).fill(true));
    expect(canary.health()).toMatchObject({ status: "healthy", suppressed: 0 });
    now = 4999;
    expect(await canary.test()).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    // A fresh failure cannot trust even a still-cached healthy background sample.
    const failed = canary.admitFailure();
    release([true, false, false, false, true]);
    expect(await failed).toBe(false);
    expect(canary.health()).toMatchObject({ status: "isolated", suppressed: 1, reachable: 1 });
  });

  it("reads a resolver outage as isolated: both addresses answer, no name does", async () => {
    const c = new Canary(vi.fn().mockResolvedValue([true, true, false, false, false]), () => 0);
    expect(await c.admitFailure()).toBe(false);
    expect(c.health()).toMatchObject({ status: "isolated", reachable: 2, suppressed: 1 });
    const named = new Canary(vi.fn().mockResolvedValue([false, false, true, true, true]), () => 0);
    expect(await named.admitFailure()).toBe(true);
  });

  it("reads a resolver serving only its cache as isolated: the front doors answer, a fresh name doesn't", async () => {
    const c = new Canary(vi.fn().mockResolvedValue([true, true, true, true, false]), () => 0);
    expect(await c.admitFailure()).toBe(false);
    expect(c.health()).toMatchObject({ status: "isolated", reachable: 4 });
  });

  it("counts a fresh name's answer or prompt 'no such name' as a working resolver, and a timeout or server failure as not", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(await freshLookup(async () => ({ address: "192.0.2.1" }))).toBe(true);
    expect(await freshLookup(() => Promise.reject(err("ENOTFOUND")))).toBe(true);
    expect(await freshLookup(() => Promise.reject(err("EAI_AGAIN")))).toBe(false);
    expect(await freshLookup(() => new Promise(() => {}), 20)).toBe(false);
    const asked: string[] = [];
    await freshLookup(async (n) => { asked.push(n); }); await freshLookup(async (n) => { asked.push(n); });
    expect(asked).toHaveLength(4);
    expect(asked[0]).not.toBe(asked[2]);
    expect(asked.slice(0, 2).map((x) => x.replace(/^canary-[0-9a-f]{16}\./, ""))).toEqual(["staygreen.io.", "example.com."]);
  });

  it("is satisfied by either zone, so one zone's outage doesn't isolate every box", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const byZone = (bad: string) => (n: string) => (n.endsWith(`.${bad}.`) ? Promise.reject(err("EAI_AGAIN")) : Promise.reject(err("ENOTFOUND")));
    expect(await freshLookup(byZone("staygreen.io"))).toBe(true);
    expect(await freshLookup(byZone("example.com"))).toBe(true);
    expect(await freshLookup(() => Promise.reject(err("EAI_AGAIN")))).toBe(false);
  });

  it("holds failures while isolated, retries, and recovers without a customer check", async () => {
    let now = 0;
    const check = vi.fn().mockRejectedValueOnce(new Error("network broken")).mockResolvedValue([true, true, true, true, true]);
    const c = new Canary(check, () => now);
    expect(await c.admitFailure()).toBe(false);
    now = 9999;
    expect(await c.admitFailure()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    now = 10_000;
    expect(await c.test()).toBe(true);
    expect(c.health()).toMatchObject({ status: "healthy", suppressed: 2 });
  });
});
