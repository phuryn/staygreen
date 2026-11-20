import { describe, expect, it } from "vitest";
import { actionsInFlight, attempt, UNREACHABLE } from "@/lib/action-call";

describe("attempt", () => {
  it("passes a resolved call through untouched", async () => {
    await expect(attempt(async () => ({ ok: true as const, votes: 3 }))).resolves.toEqual({ ok: true, votes: 3 });
  });

  it("turns a rejected call into the generic message", async () => {
    await expect(attempt(async () => Promise.reject(new Error("429")))).resolves.toEqual({ error: UNREACHABLE });
  });

  it("says a minute, because the window is sixty seconds and the edge sends no Retry-After", () => {
    expect(UNREACHABLE).toMatch(/a minute/);
  });

  it("tracks overlapping actions until both have settled", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const calls = [attempt(() => first.promise), attempt(() => second.promise)];
    expect(actionsInFlight()).toBe(true);
    first.resolve({ ok: true });
    await calls[0];
    expect(actionsInFlight()).toBe(true);
    second.reject(new Error("429"));
    await calls[1];
    expect(actionsInFlight()).toBe(false);
  });
});
