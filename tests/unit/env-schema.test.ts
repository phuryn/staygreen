import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, parsePublicEnv, parseServerEnv, publicEnvSchema, serverEnvSchema } from "@/lib/env-schema";

/* The env schema (`AGENTS.md § 1.7`, `docs/variables.md`): it refuses to build
   or boot on a missing or malformed variable, lists every problem in one
   message, never echoes a value, and reads an empty string as unset. Every
   value below is a throwaway made for this file; `.env` is never read. */

const fakeKey = (prefix: string) => `${prefix}${"Fa1ke".repeat(8)}`;

const PUBLIC = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk",
};

const SERVER = {
  ...PUBLIC,
  APP_URL: "http://localhost:3101",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SECRET_KEY: fakeKey("sb_secret_"),
  CLERK_SECRET_KEY: fakeKey("sk_test_"),
  HEARTBEAT_HOST: "in.staygreen.io",
  HEARTBEAT_TOKEN_KEY: randomBytes(32).toString("base64url"),
  CREDENTIALS_KEY: randomBytes(32).toString("base64url"),
  API_TOKEN_PEPPER: randomBytes(32).toString("base64url"),
};

/** Required by `docs/variables.md`: absent, the app must not start. */
const REQUIRED_PUBLIC = ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];
const REQUIRED_SERVER = [...REQUIRED_PUBLIC, "APP_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "CLERK_SECRET_KEY", "HEARTBEAT_HOST", "HEARTBEAT_TOKEN_KEY", "CREDENTIALS_KEY", "API_TOKEN_PEPPER"];

/** Optional: absent turns a feature off rather than breaking anything. */
const OPTIONAL_VALID: Record<string, string> = {
  SELF_HOSTED_PLAN: "builder",
  NEXT_PUBLIC_CLARITY_PROJECT_ID: "abc123xyz",
  NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "privacy@example.com",
  CLERK_WEBHOOK_SECRET: "whsec_ZmFrZXNlY3JldA",
  SENTRY_DSN: "https://public@o0.ingest.sentry.io/0",
  ANTHROPIC_API_KEY: fakeKey("sk-ant-api03-"),
  EMAIL_REDIRECT_TO: "test@blackhole.postmarkapp.com",
  TELEGRAM_BOT_TOKEN: `1234567890:${"AAFa1ke".repeat(5)}`,
};

describe("the self-hosted plan", () => {
  it.each([undefined, "", "builder"])("accepts %j on a private installation", value => {
    expect(parseServerEnv({ ...SERVER, SELF_HOSTED_PLAN: value }).SELF_HOSTED_PLAN).toBe(value || undefined);
  });

  it.each(["free", "demo", "on", "true", "Builder", "builder "])("refuses %j", value => {
    expect(refusal(() => parseServerEnv({ ...SERVER, SELF_HOSTED_PLAN: value }))).toContain("SELF_HOSTED_PLAN");
  });

  it.each([
    "https://staygreen.io", "https://tenant.staygreen.io", "http://a.b.staygreen.io:3000/path",
    "https://STAYGREEN.IO", "https://staygreen.io.", "https://tenant.staygreen.io./", "https://%73taygreen.io",
  ])("refuses Builder without billing on the hosted service (%s)", APP_URL => {
    const message = refusal(() => parseServerEnv({ ...SERVER, APP_URL, SELF_HOSTED_PLAN: "builder" }));
    expect(message).toContain("SELF_HOSTED_PLAN cannot grant Builder without billing on staygreen.io or its subdomains");
    expect(parseServerEnv({ ...SERVER, APP_URL }).SELF_HOSTED_PLAN).toBeUndefined();
    expect(parseServerEnv({ ...SERVER, APP_URL, SELF_HOSTED_PLAN: "" }).SELF_HOSTED_PLAN).toBeUndefined();
  });

  it.each(["http://localhost:3000", "https://monitor.example.com", "https://notstaygreen.io", "https://staygreen.io.example.com"])("allows an independent host (%s)", APP_URL => {
    expect(parseServerEnv({ ...SERVER, APP_URL, SELF_HOSTED_PLAN: "builder" }).SELF_HOSTED_PLAN).toBe("builder");
  });

  it("still reports an invalid APP_URL through the env error", () => {
    expect(refusal(() => parseServerEnv({ ...SERVER, APP_URL: "not a url", SELF_HOSTED_PLAN: "builder" }))).toContain("APP_URL");
  });
});

const SECRET_SHAPES = [fakeKey("sk_test_"), fakeKey("sk_live_"), fakeKey("sb_secret_"), "whsec_ZmFrZXNlY3JldA", "re_Fa1keFa1keFa1ke", fakeKey("rk_live_"), fakeKey("sk-ant-api03-"), `1234567890:${"AAFa1ke".repeat(5)}`];

/** The thrown message, for assertions on what it says and what it must not. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(EnvError);
    return (e as Error).message;
  }
  throw new Error("expected the schema to refuse");
}

const without = (source: Record<string, string>, key: string) => Object.fromEntries(Object.entries(source).filter(([k]) => k !== key));

it("defaults status addresses to production and validates environment overrides before building", () => {
  expect(parsePublicEnv(PUBLIC).NEXT_PUBLIC_STATUS_HOST).toBe("status.staygreen.io");
  expect(parseServerEnv(SERVER).STATUS_DOMAIN_SUFFIX).toBe("domains.staygreen.io");
  expect(parsePublicEnv({ ...PUBLIC, NEXT_PUBLIC_STATUS_HOST: "status-dev.example.com" }).NEXT_PUBLIC_STATUS_HOST).toBe("status-dev.example.com");
  expect(parseServerEnv({ ...SERVER, STATUS_DOMAIN_SUFFIX: "domains-dev.example.com" }).STATUS_DOMAIN_SUFFIX).toBe("domains-dev.example.com");
  for (const value of ["https://status.example.com", "status.example.com/path", "status.example.com:443", "x\n.example.com", "*.example.com"]) {
    for (const key of ["NEXT_PUBLIC_STATUS_HOST", "STATUS_DOMAIN_SUFFIX"]) {
      expect(refusal(() => parseServerEnv({ ...SERVER, [key]: value }))).toContain(key);
    }
  }
});

describe("the server half", () => {
  it("accepts a complete configuration and returns its values", () => {
    const env = parseServerEnv(SERVER);
    for (const [key, value] of Object.entries(SERVER)) expect(env[key as keyof typeof env]).toBe(value);
  });

  it.each(REQUIRED_SERVER)("refuses to start without %s", (key) => {
    const message = refusal(() => parseServerEnv(without(SERVER, key)));
    expect(message).toContain(key);
  });

  it.each(REQUIRED_SERVER)("reads an empty or blank %s as missing", (key) => {
    expect(refusal(() => parseServerEnv({ ...SERVER, [key]: "" }))).toContain(key);
    expect(refusal(() => parseServerEnv({ ...SERVER, [key]: "   " }))).toContain(key);
  });

  it("names every missing variable in one message", () => {
    const message = refusal(() => parseServerEnv({}));
    for (const key of REQUIRED_SERVER) expect(message).toContain(key);
  });

  it("requires the public half too", () => {
    expect(Object.keys(serverEnvSchema.shape)).toEqual(expect.arrayContaining(Object.keys(publicEnvSchema.shape)));
    expect(refusal(() => parseServerEnv(without(SERVER, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")))).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });
});

describe("vendor key shapes", () => {
  const malformed: [string, string][] = [
    ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "not-a-key"],
    ["CLERK_SECRET_KEY", PUBLIC.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY],
    ["CLERK_SECRET_KEY", fakeKey("sk_prod_")],
    ["SUPABASE_SECRET_KEY", fakeKey("sb_publishable_")],
    ["SUPABASE_URL", "https://example.com"],
    ["SUPABASE_URL", "http://abcdefghijklmnopqrst.supabase.co"],
    ["APP_URL", "not a url"],
    ["CREDENTIALS_KEY", randomBytes(31).toString("base64url")],
    ["CREDENTIALS_KEY", randomBytes(33).toString("base64url")],
    ["CREDENTIALS_KEY", randomBytes(32).toString("base64")],
    ["CREDENTIALS_KEY", randomBytes(32).toString("hex")],
    ["HEARTBEAT_TOKEN_KEY", randomBytes(16).toString("base64url")],
    ["HEARTBEAT_TOKEN_KEY", randomBytes(32).toString("hex")],
    ["HEARTBEAT_HOST", "https://in.staygreen.io"],
    ["HEARTBEAT_HOST", "in.staygreen.io/ping"],
    ["HEARTBEAT_HOST", "in.staygreen.io:8443"],
    ["HEARTBEAT_HOST", "intranet"],
  ];

  it.each(malformed)("refuses %s = %s, naming the key and not the value", (key, value) => {
    const message = refusal(() => parseServerEnv({ ...SERVER, [key]: value }));
    expect(message).toContain(key);
    expect(message).not.toContain(value);
  });

  // BUG (env-schema.ts:53): `z.url()` takes any scheme, so `localhost:3101` parses as the
  // scheme "localhost:" and passes as an absolute base URL.
  it.each(["localhost:3101", "mailto:ops@example.com", "javascript:alert(1)"])("refuses an APP_URL that is not http(s): %s", (value) => {
    expect(refusal(() => parseServerEnv({ ...SERVER, APP_URL: value }))).toContain("APP_URL");
  });

  it.each(["in.staygreen.io", "in-dev.example.com", "127.0.0.1:8787", "localhost:8787", "localhost"])("accepts HEARTBEAT_HOST = %s", (value) => {
    expect(parseServerEnv({ ...SERVER, HEARTBEAT_HOST: value }).HEARTBEAT_HOST).toBe(value);
  });

  it("accepts a local Supabase URL for development", () => {
    expect(parseServerEnv({ ...SERVER, SUPABASE_URL: "http://127.0.0.1:54321" }).SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("accepts a live Clerk key pair", () => {
    const env = parseServerEnv({ ...SERVER, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_ZmFrZS5jbGVyay5leGFtcGxlLmNvbSQ", CLERK_SECRET_KEY: fakeKey("sk_live_") });
    expect(env.CLERK_SECRET_KEY).toBe(fakeKey("sk_live_"));
  });
});

describe("optional variables", () => {
  it.each(Object.keys(OPTIONAL_VALID))("reads an empty %s as unset", (key) => {
    const env = parseServerEnv({ ...SERVER, [key]: "" });
    expect(env[key as keyof typeof env]).toBeUndefined();
  });

  it.each(Object.entries(OPTIONAL_VALID))("keeps %s when it is set", (key, value) => {
    const env = parseServerEnv({ ...SERVER, [key]: value });
    expect(env[key as keyof typeof env]).toBe(value);
  });

  it.each([
    ["NEXT_PUBLIC_CLARITY_PROJECT_ID", "Not A Clarity Id"],
    ["NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "not-an-address"],
    ["API_TOKEN_PEPPER", "short"],
    ["CLERK_WEBHOOK_SECRET", "not-a-signing-secret"],
    ["SENTRY_DSN", "not a url"],
    // A Clerk secret key pasted into the Claude slot.
    ["ANTHROPIC_API_KEY", fakeKey("sk_test_")],
    ["EMAIL_REDIRECT_TO", "not-an-address"],
    ["TELEGRAM_BOT_TOKEN", "not-a-bot-token"],
    ["TELEGRAM_WEBHOOK_SECRET", "short"],
  ])("refuses a malformed %s instead of ignoring it", (key, value) => {
    const message = refusal(() => parseServerEnv({ ...SERVER, [key]: value }));
    expect(message).toContain(key);
    expect(message).not.toContain(value);
  });

  it("takes alert email's three together or not at all", () => {
    const three = {
      POSTMARK_SERVER_TOKEN: "0f1e2d3c-4b5a-4968-8776-655443322110",
      EMAIL_FROM: "Staygreen alerts <alerts@staygreen.io>",
      ALERT_LINK_SECRET: randomBytes(32).toString("base64url"),
    };
    expect(parseServerEnv({ ...SERVER, ...three })).toMatchObject(three);
    expect(parseServerEnv({ ...SERVER, ...three, EMAIL_FROM: "alerts@staygreen.io" }).EMAIL_FROM).toBe("alerts@staygreen.io");
    const none = parseServerEnv({ ...SERVER, POSTMARK_SERVER_TOKEN: "", EMAIL_FROM: "", ALERT_LINK_SECRET: "" });
    expect([none.POSTMARK_SERVER_TOKEN, none.EMAIL_FROM, none.ALERT_LINK_SECRET]).toEqual([undefined, undefined, undefined]);
    for (const key of Object.keys(three) as (keyof typeof three)[]) {
      const partial = { ...SERVER, ...three, [key]: "" };
      const message = refusal(() => parseServerEnv(partial));
      expect(message).toContain("EMAIL_FROM and ALERT_LINK_SECRET are set together");
      // No value reaches the message, even when a partner is what is missing.
      for (const v of Object.values(three)) expect(message).not.toContain(v);
    }
    expect(refusal(() => parseServerEnv({ ...SERVER, ...three, POSTMARK_SERVER_TOKEN: "re_Fa1keFa1keFa1ke" }))).toContain("POSTMARK_SERVER_TOKEN is not a Postmark server token");
    expect(refusal(() => parseServerEnv({ ...SERVER, ...three, EMAIL_FROM: "Staygreen <alerts@staygreen.io>\r\nBcc: x@y.z" }))).toContain("EMAIL_FROM");
  });

  it("takes a Telegram webhook secret only with a bot token", () => {
    const secret = randomBytes(32).toString("base64url");
    expect(refusal(() => parseServerEnv({ ...SERVER, TELEGRAM_WEBHOOK_SECRET: secret }))).toContain("TELEGRAM_WEBHOOK_SECRET is set without TELEGRAM_BOT_TOKEN");
    const both = parseServerEnv({ ...SERVER, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_TOKEN: OPTIONAL_VALID.TELEGRAM_BOT_TOKEN });
    expect(both.TELEGRAM_WEBHOOK_SECRET).toBe(secret);
  });
});

describe("the public half", () => {
  it("requires the shared control key before activating the status edge", () => {
    expect(refusal(() => parseServerEnv({ ...SERVER, STATUS_EDGE_ENABLED: "on" }))).toContain("EDGE_CONTROL_SECRET");
    expect(parseServerEnv({ ...SERVER, STATUS_EDGE_ENABLED: "on", EDGE_CONTROL_SECRET: randomBytes(32).toString("base64url") }).STATUS_EDGE_ENABLED).toBe("on");
    expect(parseServerEnv({ ...SERVER, STATUS_EDGE_ENABLED: "off" }).STATUS_EDGE_ENABLED).toBe("off");
  });
  it("needs no server key, so a build without secrets can still check it", () => {
    expect(parsePublicEnv(PUBLIC).NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).toBe(PUBLIC.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  });

  it("returns only NEXT_PUBLIC_ keys, whatever else the environment holds", () => {
    const env = parsePublicEnv({ ...SERVER, ...OPTIONAL_VALID });
    expect(Object.keys(env).sort()).toEqual(["NEXT_PUBLIC_CLARITY_PROJECT_ID", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "NEXT_PUBLIC_STATUS_HOST"]);
  });

  it("declares nothing that is not NEXT_PUBLIC_", () => {
    expect(Object.keys(publicEnvSchema.shape).filter((k) => !k.startsWith("NEXT_PUBLIC_"))).toEqual([]);
  });

  it.each(REQUIRED_PUBLIC)("refuses to build without %s", (key) => {
    expect(refusal(() => parsePublicEnv(without(PUBLIC, key)))).toContain(key);
  });

  const publicKeys = Object.keys(publicEnvSchema.shape);
  const cases = publicKeys.flatMap((key) =>
    SECRET_SHAPES.map((secret) => [key, key === "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL" ? `${secret}@example.com` : secret] as [string, string]),
  );

  it.each(cases)("refuses a secret-shaped value in %s and does not print it (%s)", (key, value) => {
    const message = refusal(() => parsePublicEnv({ ...PUBLIC, [key]: value }));
    expect(message).toContain(key);
    expect(message).not.toContain(value);
  });
});

describe("env(), the boot check", () => {
  /** A fresh `env.ts` over exactly `source`: every other schema key is blanked, which the
   *  schema reads as unset, so the developer's shell cannot decide what this asserts. */
  async function bootWith(source: Record<string, string>) {
    vi.resetModules();
    for (const key of Object.keys(serverEnvSchema.shape)) vi.stubEnv(key, "");
    for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
    const [{ env }, schema] = await Promise.all([import("@/lib/env"), import("@/lib/env-schema")]);
    return { env, EnvError: schema.EnvError };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses the first read on a partial configuration", async () => {
    const { env, EnvError: Fresh } = await bootWith(without(SERVER, "CREDENTIALS_KEY"));
    expect(() => env()).toThrow(Fresh);
  });

  it("returns the parsed configuration when it is complete", async () => {
    const { env } = await bootWith(SERVER);
    expect(env().CREDENTIALS_KEY).toBe(SERVER.CREDENTIALS_KEY);
    expect(env().SENTRY_DSN).toBeUndefined();
  });
});
