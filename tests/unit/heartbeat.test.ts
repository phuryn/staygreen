import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seal } from "@/lib/credentials";
import { heartbeatContext, newHeartbeat, openHeartbeat } from "@/lib/heartbeat";
import { verifyToken } from "@/lib/heartbeat-token";

/* A heartbeat's ping URL (`AGENTS.md § 2.8`): its hash is the receiver's lookup
   key, and a copy sealed to its monitor is what that monitor's page shows. The
   keys are throwaways fixed here; `CREDENTIALS_KEY`, `HEARTBEAT_TOKEN_KEY`, `HEARTBEAT_HOST` and
   `.env` are never read. */

const KEY = vi.hoisted(() => Buffer.alloc(32, 7).toString("base64url"));
const TAG_KEY = vi.hoisted(() => Buffer.alloc(32, 9).toString("base64url"));
const config = vi.hoisted(() => ({ host: "in.staygreen.io" }));
vi.mock("@/lib/env", () => ({ env: () => ({ CREDENTIALS_KEY: KEY, HEARTBEAT_TOKEN_KEY: TAG_KEY, HEARTBEAT_HOST: config.host }) }));

const MON = "mon_aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "mon_bbbbbbbbbbbbbbbbbbbbbbbb";
const tokenOf = (url: string) => new URL(url).pathname.slice(1);

describe("newHeartbeat", () => {
  it("makes a 32-byte token tagged under HEARTBEAT_TOKEN_KEY, its SHA-256, and a sealed copy that doesn't contain it", async () => {
    const hb = await newHeartbeat(MON);
    expect(hb.url).toMatch(/^https:\/\/in\.staygreen\.io\/[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(tokenOf(hb.url), "base64url")).toHaveLength(32);
    expect(await verifyToken(TAG_KEY, tokenOf(hb.url))).toBe(true);
    expect(await verifyToken(KEY, tokenOf(hb.url))).toBe(false);
    expect(hb.hash).toBe(createHash("sha256").update(tokenOf(hb.url)).digest("hex"));
    expect(hb.sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(hb.sealed).not.toContain(tokenOf(hb.url));
  });

  it("never makes the same token twice", async () => {
    expect(new Set(await Promise.all(Array.from({ length: 50 }, async () => (await newHeartbeat(MON)).url))).size).toBe(50);
  });
});

describe("the ping URL's host", () => {
  afterEach(() => {
    config.host = "in.staygreen.io";
  });

  it("is HEARTBEAT_HOST, so development's URLs name development's Worker", async () => {
    config.host = "in-dev.example.com";
    expect((await newHeartbeat(MON)).url).toMatch(/^https:\/\/in-dev\.example\.com\/[A-Za-z0-9_-]{43}$/);
  });

  it("is http only for a local wrangler dev", async () => {
    config.host = "127.0.0.1:8787";
    expect((await newHeartbeat(MON)).url).toMatch(/^http:\/\/127\.0\.0\.1:8787\//);
    config.host = "localhost:8787";
    expect((await newHeartbeat(MON)).url).toMatch(/^http:\/\/localhost:8787\//);
  });

  it("is read when the URL is shown, so a URL shown again after the host changes names the new one", async () => {
    const hb = await newHeartbeat(MON);
    config.host = "in-dev.example.com";
    expect(openHeartbeat(hb.sealed, MON)).toBe(hb.url.replace("in.staygreen.io", "in-dev.example.com"));
  });
});

describe("openHeartbeat", () => {
  it("gives back the URL on the monitor it was made for", async () => {
    const hb = await newHeartbeat(MON);
    expect(openHeartbeat(hb.sealed, MON)).toBe(hb.url);
  });

  it("gives nothing for a copy moved onto another monitor", async () => {
    expect(openHeartbeat((await newHeartbeat(MON)).sealed, OTHER)).toBeNull();
  });

  it("gives nothing for the monitor's secret header sealed under the same key", () => {
    expect(openHeartbeat(seal("Bearer sk_live_x", `monitor:${MON}/header:Authorization`), MON)).toBeNull();
  });

  it.each(["", "v1", "not sealed", "v1.AAAA.AAAA"])("gives nothing for %j", (bad) => {
    expect(openHeartbeat(bad, MON)).toBeNull();
  });

  it("binds to the monitor and the purpose", () => {
    expect(heartbeatContext(MON)).toBe(`monitor:${MON}/heartbeat_url`);
  });
});
