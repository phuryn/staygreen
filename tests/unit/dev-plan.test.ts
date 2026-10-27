import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The development-only plan switch (`session.ts`, `docs/variables.md`
   DEV_PLAN_OVERRIDE). A cookie stands in for a checkout under `next dev`.
   What must hold: it never turns on in
   production or without the flag, it only ever answers for a signed-in caller,
   and a cookie it doesn't recognise can only mean Free. Clerk's `auth()` and
   Next's `cookies()` are mocked; nothing here has a key or a request. */

const clerk = vi.hoisted(() => ({
  session: { userId: "user_1" as string | null, holds: [] as string[] },
}));
const jar = vi.hoisted(() => ({ values: new Map<string, string>(), throws: false }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({
    userId: clerk.session.userId,
    orgId: "org_A",
    orgRole: "org:admin",
    has: ({ feature }: { feature: string }) => clerk.session.holds.includes(feature),
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (jar.throws) throw new Error("cookies() was called outside a request scope");
    return { get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined) };
  },
}));

const { currentEntitlements, devPlanOverrideEnabled, devPlanSimulation, DEV_PLAN_COOKIE } = await import("@/lib/session");
const { builderSlugs, FREE, limits } = await import("@/lib/plans");
const { serverEnvSchema } = await import("@/lib/env-schema");

const BUILDER_ALL = { plan: "builder", features: [...builderSlugs], limits: limits.builder };

beforeEach(() => {
  clerk.session = { userId: "user_1", holds: [] };
  jar.values = new Map();
  jar.throws = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const env = (nodeEnv: string, flag?: string) => {
  vi.stubEnv("NODE_ENV", nodeEnv);
  if (flag === undefined) vi.stubEnv("DEV_PLAN_OVERRIDE", undefined);
  else vi.stubEnv("DEV_PLAN_OVERRIDE", flag);
};

describe("the dev plan cookie", () => {
  it("uses new Clerk features on the next request after checkout, without an app-side subscription write", async () => {
    env("production");
    expect(await currentEntitlements()).toEqual(FREE);
    clerk.session.holds = [...builderSlugs];
    expect(await currentEntitlements()).toEqual(BUILDER_ALL);
    clerk.session.holds = [];
    expect(await currentEntitlements()).toEqual(FREE);
  });

  it("is honoured under next dev with the flag on: builder means every Builder feature", async () => {
    env("development", "on");
    jar.values.set(DEV_PLAN_COOKIE, "builder");
    expect(await currentEntitlements()).toEqual(BUILDER_ALL);
  });

  it("is ignored in production, flag and cookie notwithstanding", async () => {
    env("production", "on");
    jar.values.set(DEV_PLAN_COOKIE, "builder");
    expect(devPlanOverrideEnabled()).toBe(false);
    expect(await currentEntitlements()).toEqual(FREE);
  });

  it("is ignored in the test runners, which run as NODE_ENV=test", async () => {
    env("test", "on");
    jar.values.set(DEV_PLAN_COOKIE, "builder");
    expect(await currentEntitlements()).toEqual(FREE);
  });

  it.each([undefined, "off", "", "true", "ON"])("is ignored when DEV_PLAN_OVERRIDE is %j", async (flag) => {
    env("development", flag);
    jar.values.set(DEV_PLAN_COOKIE, "builder");
    expect(devPlanOverrideEnabled()).toBe(false);
    expect(await currentEntitlements()).toEqual(FREE);
  });

  it.each(["free", "Builder", "pro", "", "builder "])("reads %j as Free, so an unknown value can only lower the plan", async (value) => {
    env("development", "on");
    clerk.session.holds = [...builderSlugs]; // even when Clerk says Builder
    jar.values.set(DEV_PLAN_COOKIE, value);
    expect(await currentEntitlements()).toEqual(FREE);
  });

  it("leaves Clerk's answer alone when no cookie is set", async () => {
    env("development", "on");
    clerk.session.holds = ["scale_builder", "white_label"];
    expect(await currentEntitlements()).toEqual({ plan: "builder", features: ["scale_builder", "white_label"], limits: limits.builder });
  });

  it("gives a signed-out visitor Free whatever the cookie says", async () => {
    env("development", "on");
    clerk.session.userId = null;
    jar.values.set(DEV_PLAN_COOKIE, "builder");
    expect(await currentEntitlements()).toEqual(FREE);
  });

  it("falls back to Clerk when there is no request to read a cookie from", async () => {
    env("development", "on");
    jar.throws = true;
    clerk.session.holds = [];
    expect(await currentEntitlements()).toEqual(FREE);
  });
});

describe("devPlanSimulation, which decides whether the billing screen shows the switch", () => {
  it("is null in production and without the flag", async () => {
    env("production", "on");
    expect(await devPlanSimulation()).toBeNull();
    env("development");
    expect(await devPlanSimulation()).toBeNull();
  });

  it("says whether Builder is being simulated under next dev with the flag on", async () => {
    env("development", "on");
    expect(await devPlanSimulation()).toEqual({ builder: false });
    jar.values.set(DEV_PLAN_COOKIE, "builder");
    expect(await devPlanSimulation()).toEqual({ builder: true });
  });
});

describe("DEV_PLAN_OVERRIDE in the env schema", () => {
  const SERVER = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk",
    APP_URL: "http://localhost:3101",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_SECRET_KEY: `sb_secret_${"Fa1ke".repeat(8)}`,
    CLERK_SECRET_KEY: `sk_test_${"Fa1ke".repeat(8)}`,
    HEARTBEAT_HOST: "in.staygreen.io",
    HEARTBEAT_TOKEN_KEY: randomBytes(32).toString("base64url"),
    CREDENTIALS_KEY: randomBytes(32).toString("base64url"),
    API_TOKEN_PEPPER: randomBytes(32).toString("base64url"),
  };

  it.each([undefined, "", "on", "off"])("accepts %j", (value) => {
    expect(serverEnvSchema.safeParse({ ...SERVER, DEV_PLAN_OVERRIDE: value }).success).toBe(true);
  });

  it.each(["yes", "true", "1", "ON"])("refuses %j, so a typo is caught at dev start rather than silently ignored", (value) => {
    expect(serverEnvSchema.safeParse({ ...SERVER, DEV_PLAN_OVERRIDE: value }).success).toBe(false);
  });
});
