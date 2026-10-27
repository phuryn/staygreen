import { describe, expect, it } from "vitest";
import { judge } from "@/checks/assertions";
import { acceptAssertion, bodyForModel, healthJson, HEALTH_BODY_BYTES, statusAssertion } from "@/lib/health-body";

/* A health route's body, read into the assertions a suggested check carries (`health-body.ts`):
   the one code proposes, and the gate every proposal passes, the model's included. The bodies
   are what each framework's health endpoint answers. */

const SPRING = { status: "UP", components: { db: { status: "UP", details: { database: "PostgreSQL", validationQuery: "isValid()" } }, diskSpace: { status: "UP", details: { total: 499963174912, free: 91300069376, threshold: 10485760 } }, ping: { status: "UP" } } };
const IETF = { status: "pass", version: "1", releaseId: "1.2.2", checks: { "postgres:responseTime": [{ componentId: "dfd6cf2b", observedValue: 12, observedUnit: "ms", status: "pass", time: "2026-10-22T10:01:00Z" }] } };
const NODE = { status: "ok", uptime: 12345.6, timestamp: 1761127260000, checks: { database: { status: "ok", latencyMs: 4 }, redis: { connected: true, latency_ms: 1.2 } }, version: "3.4.1", host: "web-1" };
const bytes = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

describe("healthJson", () => {
  it("is a whole JSON object or array, and nothing else", () => {
    expect(healthJson(bytes(SPRING), false)).toEqual(SPRING);
    expect(healthJson(bytes([1, 2]), false)).toEqual([1, 2]);
    expect(healthJson(bytes("OK"), false)).toBeUndefined();
    expect(healthJson(bytes("42"), false)).toBeUndefined();
    expect(healthJson(bytes("null"), false)).toBeUndefined();
    expect(healthJson(bytes('{"status":"ok"'), false)).toBeUndefined();
    expect(healthJson(bytes(SPRING), true)).toBeUndefined();
    expect(healthJson(new Uint8Array(HEALTH_BODY_BYTES + 1).fill(32), false)).toBeUndefined();
  });
});

describe("statusAssertion", () => {
  it.each([
    ["Spring Boot's", SPRING, "application/vnd.spring-boot.actuator.v3+json", { path: "$.status", op: "==", value: "UP" }],
    ["the IETF draft's pass", IETF, "application/health+json", { path: "$.status", op: "==", value: "pass" }],
    ["the IETF draft's warn, as not failing", { status: "warn" }, "application/health+json", { path: "$.status", op: "!=", value: "fail" }],
    ["a plain ok", { status: "ok" }, "application/json", { path: "$.status", op: "==", value: "ok" }],
    ["a boolean status", { status: true }, "application/json", { path: "$.status", op: "==", value: "true" }],
    ["an ok flag", { ok: true }, "application/json", { path: "$.ok", op: "==", value: "true" }],
    ["a healthy flag", { healthy: true, checks: [] }, "application/json", { path: "$.healthy", op: "==", value: "true" }],
  ])("reads %s body", (_, json, type, assertion) => {
    expect(statusAssertion(json, type)).toEqual(assertion);
    expect(judge(json, assertion).pass).toBe(true);
  });

  it("proposes nothing for a body that doesn't say it is healthy, or isn't an object", () => {
    expect(statusAssertion({ status: "fail" }, "application/health+json")).toBeNull();
    expect(statusAssertion({ status: "DOWN" }, "application/json")).toBeNull();
    // `warn` is only the IETF shape's word for a pass with a note.
    expect(statusAssertion({ status: "warn" }, "application/json")).toBeNull();
    expect(statusAssertion({ ok: false }, "application/json")).toBeNull();
    expect(statusAssertion({ ok: "yes" }, "application/json")).toBeNull();
    expect(statusAssertion([{ status: "ok" }], "application/json")).toBeNull();
    expect(statusAssertion(undefined, "application/json")).toBeNull();
  });
});

describe("acceptAssertion", () => {
  it("takes a nested component's status, written as the add form writes it", () => {
    expect(acceptAssertion(SPRING, { path: "$.components.db.status", op: "==", value: '"UP"' })).toEqual({ path: "$.components.db.status", op: "==", value: "UP" });
    expect(acceptAssertion(NODE, { path: "$.checks.redis.connected", op: "==", value: "true" })).toEqual({ path: "$.checks.redis.connected", op: "==", value: "true" });
    expect(acceptAssertion(IETF, { path: '$.checks["postgres:responseTime"][0].status', op: "==", value: "pass" })).toEqual({ path: '$.checks["postgres:responseTime"][0].status', op: "==", value: "pass" });
    expect(acceptAssertion(NODE, { path: "$.checks.database.status", op: "!=", value: "down" })).toEqual({ path: "$.checks.database.status", op: "!=", value: "down" });
    expect(acceptAssertion(SPRING, { path: "$.components.db", op: "exists", value: "anything" })).toEqual({ path: "$.components.db", op: "exists", value: "" });
  });

  it("takes a latency bound with room over what was measured, and never a tight one or a number that isn't a time", () => {
    expect(acceptAssertion(NODE, { path: "$.checks.database.latencyMs", op: "<", value: "100" })).toEqual({ path: "$.checks.database.latencyMs", op: "<", value: "100" });
    expect(acceptAssertion(NODE, { path: "$.checks.redis.latency_ms", op: "<=", value: "50" })).toMatchObject({ op: "<=", value: "50" });
    expect(acceptAssertion(IETF, { path: '$.checks["postgres:responseTime"][0].observedValue', op: "<", value: "500" })).toBeNull();
    // 2x is the least room: 4 ms measured, 7 is too tight.
    expect(acceptAssertion(NODE, { path: "$.checks.database.latencyMs", op: "<", value: "7" })).toBeNull();
    expect(acceptAssertion(NODE, { path: "$.uptime", op: "<", value: "999999" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.components.diskSpace.details.free", op: "<", value: "999999999999" })).toBeNull();
    expect(acceptAssertion({ queue: { items: 3 } }, { path: "$.queue.items", op: "<", value: "100" })).toBeNull();
  });

  it("never compares what changes on its own: a version, a time, a host, an id, a count", () => {
    for (const path of ["$.version", "$.timestamp", "$.host", "$.uptime"]) {
      for (const op of ["==", "!=", "<", "<="]) expect(acceptAssertion(NODE, { path, op, value: "x" }), `${path} ${op}`).toBeNull();
    }
    expect(acceptAssertion({ build: { ok: true } }, { path: "$.build.ok", op: "==", value: "true" })).toEqual({ path: "$.build.ok", op: "==", value: "true" });
    expect(acceptAssertion({ createdAt: true }, { path: "$.createdAt", op: "==", value: "true" })).toBeNull();
    expect(acceptAssertion({ heartbeat: true }, { path: "$.heartbeat", op: "==", value: "true" })).toEqual({ path: "$.heartbeat", op: "==", value: "true" });
  });

  it("takes a flag only at the value a healthy app holds, so a check never passes while the app is unwell", () => {
    const unwell = { status: "ok", checks: { database: { ok: false } }, ok: false, degraded: false, maintenance: true, error: { code: "db" } };
    for (const [path, op, value] of [["$.checks.database.ok", "==", "false"], ["$.checks.database.ok", "!=", "true"], ["$.ok", "==", "false"], ["$.maintenance", "==", "true"], ["$.maintenance", "!=", "false"], ["$.error", "exists", ""]])
      expect(acceptAssertion(unwell, { path, op, value }), `${path} ${op} ${value}`).toBeNull();
    expect(acceptAssertion(unwell, { path: "$.degraded", op: "==", value: "false" })).toEqual({ path: "$.degraded", op: "==", value: "false" });
    expect(acceptAssertion(unwell, { path: "$.degraded", op: "!=", value: "true" })).toEqual({ path: "$.degraded", op: "!=", value: "true" });
    const well = { ok: true, checks: { cache: { healthy: true } } };
    expect(acceptAssertion(well, { path: "$.ok", op: "==", value: "true" })).toEqual({ path: "$.ok", op: "==", value: "true" });
    expect(acceptAssertion(well, { path: "$.checks.cache.healthy", op: "!=", value: "false" })).toEqual({ path: "$.checks.cache.healthy", op: "!=", value: "false" });
  });

  it("refuses one that fails on the body now, or says nothing about health", () => {
    expect(acceptAssertion(SPRING, { path: "$.components.db.status", op: "==", value: "DOWN" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.status", op: "==", value: "ok" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.components.db.details.database", op: "==", value: "PostgreSQL" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.components.db.status", op: "!=", value: "UP" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.status", op: "exists", value: "" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.status", op: "matches", value: "UP" })).toBeNull();
  });

  it("refuses a path the engine can't read, one too deep or too long, a value too long, or a field of the wrong type", () => {
    // A path without its `$` is one the engine reads, and comes back written in full.
    expect(acceptAssertion(SPRING, { path: "components.db.status", op: "==", value: "UP" })).toEqual({ path: "$.components.db.status", op: "==", value: "UP" });
    expect(acceptAssertion(SPRING, { path: "$..status", op: "==", value: "UP" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.nope", op: "exists", value: "" })).toBeNull();
    const deep = { a: { b: { c: { d: { e: { f: { g: { status: "ok" } } } } } } } };
    expect(acceptAssertion(deep, { path: "$.a.b.c.d.e.f.g.status", op: "==", value: "ok" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: `$.status${" ".repeat(200)}`, op: "==", value: "UP" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.status", op: "==", value: "x".repeat(101) })).toBeNull();
    expect(acceptAssertion(SPRING, { path: 1, op: "==", value: "UP" })).toBeNull();
    expect(acceptAssertion(SPRING, { path: "$.status", op: null, value: "UP" })).toBeNull();
  });
});

describe("a body recorded 2026-10-22", () => {
  // play.grafana.org/api/health, as the live run read it.
  const GRAFANA = { database: "ok", version: "13.3.0-39455295433", commit: "7c22c85a8943dda93dd27a65e9c5d988a8be5758", enterpriseCommit: "528c3eca3d1d4e94ae36c287d029e5f551249dd3" };

  it("Grafana's: no status for code to read, the database's word for the model's proposal, and never its version or commits", () => {
    expect(healthJson(bytes(JSON.stringify(GRAFANA, null, 2)), false)).toEqual(GRAFANA);
    expect(statusAssertion(GRAFANA, "application/json; charset=UTF-8")).toBeNull();
    // What the model proposed on the live run, and what code kept.
    expect(acceptAssertion(GRAFANA, { path: "$.database", op: "==", value: '"ok"' })).toEqual({ path: "$.database", op: "==", value: "ok" });
    expect(acceptAssertion(GRAFANA, { path: "$.version", op: "exists", value: "" })).toBeNull();
    expect(acceptAssertion(GRAFANA, { path: "$.commit", op: "==", value: GRAFANA.commit })).toBeNull();
    expect(acceptAssertion(GRAFANA, { path: "$.enterpriseCommit", op: "!=", value: "fail" })).toBeNull();
  });
});

describe("bodyForModel", () => {
  it("is a short JSON text: five levels, 40 keys, 5 items, 80 characters a string", () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    const out = JSON.parse(bodyForModel({ wide, list: Array.from({ length: 9 }, (_, i) => i), long: "x".repeat(300), a: { b: { c: { d: { e: { f: 1 } } } } } }, 10_000));
    expect(Object.keys(out.wide)).toHaveLength(40);
    expect(out.list).toEqual([0, 1, 2, 3, 4]);
    expect(out.long).toHaveLength(80);
    expect(out.a.b.c.d).toEqual({ e: {} });
    expect(bodyForModel(SPRING, 100).length).toBeLessThanOrEqual(100);
  });

  it("masks what a health route echoes that it shouldn't: a credential, a token, an address with a password", () => {
    // Built at runtime: GitHub's push protection refuses a literal shaped like a live Stripe key, fake or not.
    const leaky = {
      status: "ok",
      config: { password: "hunter2-hunter2", apiKey: "sk_live_" + "51H" + "x".repeat(22) + "ABCD", url: "postgres://app:s3cretpw@db.internal:5432/app", authorization: "Bearer abc.def.ghi" },
      note: "token=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    };
    const out = bodyForModel(leaky, 10_000);
    for (const secret of ["hunter2-hunter2", "sk_live_51H", "s3cretpw", "abc.def.ghi", "ghp_xxxxxxxx"]) expect(out).not.toContain(secret);
    expect(JSON.parse(out).status).toBe("ok");
  });
});
