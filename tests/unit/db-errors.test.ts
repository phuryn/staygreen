import { describe, expect, it } from "vitest";
import { constraintOf, describeDbError, isNotFound, type ErrorContext } from "@/lib/db-errors";
import { demoSlug, entitlementsFrom, FREE, limits } from "@/lib/plans";

/* What the database refused, in the builder's words (`src/lib/db-errors.ts`).
   The sentences carry the plan's numbers, so they are asserted against
   `limits`, never against copied figures; `not_found` is never worded here,
   because missing and foreign are the same 404 (`AGENTS.md § 1.1`). */

const BUILDER = entitlementsFrom((slug) => slug !== demoSlug);
const free: ErrorContext = { entitlements: FREE };
const builder: ErrorContext = { entitlements: BUILDER };

const raise = (message: string) => ({ code: "P0001", message, details: null });
const violation = (code: string, constraint: string) => ({ code, message: `new row for relation "x" violates check constraint "${constraint}"`, details: null });

/** The fallback sentence for each SQLSTATE class, read from the module itself. */
const fallback = {
  unique: describeDbError(violation("23505", "no_such_constraint"), free),
  check: describeDbError(violation("23514", "no_such_constraint"), free),
  other: describeDbError({ code: "XX000", message: "boom" }, free),
};

describe("isNotFound", () => {
  it("recognises the functions' not_found refusal, and nothing else", () => {
    expect(isNotFound({ code: "PT404", message: "not_found" })).toBe(true);
    expect(isNotFound({ code: "PT404", message: "monitor_limit" })).toBe(false);
    expect(isNotFound({ code: "PGRST202", message: "not_found" })).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe("constraintOf", () => {
  it("reads the constraint a violation names, from the message or the details", () => {
    expect(constraintOf(violation("23514", "apps_name_check"))).toBe("apps_name_check");
    expect(constraintOf({ code: "23505", message: "duplicate key value", details: 'Key (slug)=(x) already exists; constraint "status_pages_slug_key"' })).toBe("status_pages_slug_key");
    expect(constraintOf({ code: "23505", message: "duplicate key value" })).toBeNull();
  });
});

describe("plan refusals carry the plan's own numbers", () => {
  it("monitor_limit", () => {
    expect(describeDbError(raise("monitor_limit"), free)).toContain(String(limits.free.monitors));
    expect(describeDbError(raise("monitor_limit"), free)).toContain(String(limits.builder.monitors));
    expect(describeDbError(raise("monitor_limit"), builder)).toContain(String(limits.builder.monitors));
  });

  it("heartbeat_limit", () => {
    expect(describeDbError(raise("heartbeat_limit"), free)).toContain(String(limits.free.heartbeats));
    expect(describeDbError(raise("heartbeat_limit"), free)).toContain(String(limits.builder.heartbeats));
    expect(describeDbError(raise("heartbeat_limit"), builder)).toContain(String(limits.builder.heartbeats));
  });

  it("app_limit names Free's one app and Builder's number", () => {
    expect(describeDbError(raise("app_limit"), free)).toBe(`Free includes 1 app. Builder includes ${limits.builder.apps}, each with its own monitors and status page.`);
    expect(describeDbError(raise("app_limit"), builder)).toBe(`Builder includes ${limits.builder.apps} apps, and they're all in use.`);
  });

  it("page_limit", () => {
    expect(describeDbError(raise("page_limit"), free)).toContain(String(limits.builder.statusPages));
    expect(describeDbError(raise("page_limit"), builder)).toContain(String(limits.builder.statusPages));
  });

  it("assertion_limit names the heartbeat allowance for a heartbeat and the HTTP one otherwise", () => {
    expect(describeDbError(raise("assertion_limit"), { ...free, type: "heartbeat" })).toContain(`${limits.free.heartbeatAssertions} assertion `);
    expect(describeDbError(raise("assertion_limit"), { ...free, type: "http" })).toContain(`${limits.free.assertions} assertions`);
    expect(describeDbError(raise("assertion_limit"), { ...builder, type: "heartbeat" })).toContain(`${limits.builder.heartbeatAssertions} assertions`);
    expect(describeDbError(raise("assertion_limit"), { ...builder, type: "http" })).toContain(`${limits.builder.assertions} assertions`);
  });

  it("interval_not_allowed names the plan's shortest interval", () => {
    expect(describeDbError(raise("interval_not_allowed"), free)).toContain(`${limits.free.httpIntervalMin} minutes`);
    expect(describeDbError(raise("interval_not_allowed"), builder)).toContain(`${limits.builder.httpIntervalMin} minute.`);
  });

  it("host_limit names the per-host cap and the host when it is known", () => {
    const withHost = describeDbError(raise("host_limit"), { ...free, host: "api.example.com" });
    expect(withHost).toContain(String(limits.free.perHost));
    expect(withHost).toContain("api.example.com");
    expect(describeDbError(raise("host_limit"), free)).toContain(String(limits.free.perHost));
  });

  it("speaks of Builder's limit as reached, not as an upsell, on Builder", () => {
    const onFree = describeDbError(raise("monitor_limit"), free);
    const onBuilder = describeDbError(raise("monitor_limit"), builder);
    expect(onBuilder).not.toBe(onFree);
    expect(onBuilder).not.toContain(String(limits.free.monitors));
  });
});

describe("other refusals", () => {
  const named = [
    "type_not_available",
    "white_label_required",
    "private_pages_required",
    "components_invalid",
    "note_published",
    "pause_window_invalid",
    "organization_required",
    "auto_monitor",
  ];

  it("gives each named refusal its own sentence, none of them a fallback", () => {
    const sentences = named.map((m) => describeDbError(raise(m), free));
    expect(new Set(sentences).size).toBe(named.length);
    for (const s of sentences) expect(Object.values(fallback)).not.toContain(s);
  });

  it("words the known unique violations, each differently", () => {
    const keys = ["apps_workspace_name_key", "status_pages_slug_key", "status_pages_app_id_key"];
    const sentences = keys.map((k) => describeDbError(violation("23505", k), free));
    expect(new Set(sentences).size).toBe(keys.length);
    expect(sentences).not.toContain(fallback.unique);
  });

  it("words the known check violations, and never with the unique fallback", () => {
    const keys = [
      "status_pages_slug_check",
      "status_pages_edge_slug_check",
      "apps_name_check",
      "apps_url_check",
      "monitors_name_check",
      "status_pages_name_check",
      "status_pages_logo_text_check",
      "status_pages_accent_check",
      "incident_notes_body_check",
    ];
    for (const k of keys) {
      const s = describeDbError(violation("23514", k), free);
      expect(s, k).not.toBe(fallback.check);
      expect(s, k).not.toBe(fallback.unique);
    }
  });

  it("falls back by SQLSTATE class, and never says not found", () => {
    expect(new Set(Object.values(fallback)).size).toBe(3);
    expect(describeDbError(violation("23503", "monitors_app_id_fkey"), free)).not.toBe(fallback.other);
    expect(describeDbError({ code: "PT404", message: "not_found" }, free)).toBe(fallback.other);
  });

  it("never echoes the database's own message", () => {
    const leaky = { code: "XX000", message: "relation monitor_secrets: value=sk_live_Fa1ke", details: "row (mon_x, Authorization, Bearer abc)" };
    const s = describeDbError(leaky, free);
    expect(s).not.toContain("sk_live_Fa1ke");
    expect(s).not.toContain("Bearer abc");
  });
});
