import { describe, expect, it } from "vitest";
import { judge, judgeAll, parsePath, read } from "../../src/checks/assertions";

/* Assertions on a JSON body or a heartbeat's fields (`spec.md § 3.1, § 3.3`). */

const body = {
  status: "ok",
  db: { ok: true, latency_ms: 42, "read-replica": { lag: "3" } },
  items: [{ id: 1 }, { id: 2 }],
  tags: ["eu", "prod"],
  count: "12",
  empty: null,
};

const pass = (path: string, op: string, value = "") => judge(body, { path, op, value }).pass;

describe("parsePath", () => {
  it("reads dots, brackets, quotes and indexes", () => {
    expect(parsePath("$.db.ok")).toEqual(["db", "ok"]);
    expect(parsePath('$.db["read-replica"].lag')).toEqual(["db", "read-replica", "lag"]);
    expect(parsePath("$['db']['ok']")).toEqual(["db", "ok"]);
    expect(parsePath("$.items[1].id")).toEqual(["items", 1, "id"]);
    expect(parsePath("$")).toEqual([]);
  });

  it("takes a heartbeat field without the $.", () => {
    expect(parsePath("count")).toEqual(["count"]);
  });

  it("refuses what it can't read", () => {
    expect(parsePath("$.db..ok")).toBeNull();
    expect(parsePath("$.items[x]")).toBeNull();
    expect(parsePath("$.a b")).toBeNull();
  });
});

describe("read", () => {
  it("finds nothing past a scalar, an index on an object or a key on an array", () => {
    expect(read(body, ["status", "x"])).toBeUndefined();
    expect(read(body, ["db", 0])).toBeUndefined();
    expect(read(body, ["items", "length"])).toBeUndefined();
    expect(read(body, ["constructor"])).toBeUndefined();
  });
});

describe("judge", () => {
  it("exists", () => {
    expect(pass("$.db.ok", "exists")).toBe(true);
    expect(pass("$.empty", "exists")).toBe(true);
    expect(pass("$.db.missing", "exists")).toBe(false);
  });

  it("== and != take the value the way a person means it", () => {
    expect(pass("$.status", "==", "ok")).toBe(true);
    expect(pass("$.status", "==", '"ok"')).toBe(true);
    expect(pass("$.db.ok", "==", "true")).toBe(true);
    expect(pass("$.db.latency_ms", "==", "42")).toBe(true);
    expect(pass("$.count", "==", "12")).toBe(true);
    expect(pass("$.empty", "==", "null")).toBe(true);
    expect(pass("$.tags", "==", '["eu","prod"]')).toBe(true);
    expect(pass("$.status", "!=", "down")).toBe(true);
    expect(pass("$.status", "!=", "ok")).toBe(false);
  });

  it("a missing value fails == and != alike", () => {
    expect(pass("$.nope", "==", "x")).toBe(false);
    expect(pass("$.nope", "!=", "x")).toBe(false);
  });

  it("compares numbers, also inside strings, and fails anything that isn't one", () => {
    expect(pass("$.db.latency_ms", "<", "500")).toBe(true);
    expect(pass("$.db.latency_ms", ">=", "42")).toBe(true);
    expect(pass("$.db.latency_ms", ">", "42")).toBe(false);
    expect(pass("count", ">", "0")).toBe(true);
    expect(pass('$.db["read-replica"].lag', "<=", "3")).toBe(true);
    expect(pass("$.status", "<", "5")).toBe(false);
  });

  it("contains looks in strings and arrays", () => {
    expect(pass("$.status", "contains", "o")).toBe(true);
    expect(pass("$.tags", "contains", "prod")).toBe(true);
    expect(pass("$.tags", "contains", "us")).toBe(false);
    expect(pass("$.db", "contains", "ok")).toBe(false);
  });

  it("an unknown operator or an unreadable path never passes", () => {
    expect(pass("$.status", "~=", "ok")).toBe(false);
    expect(pass("$.db..ok", "exists")).toBe(false);
  });

  it("says what it got, cut to 100 characters", () => {
    expect(judge(body, { path: "$.db.latency_ms", op: "<", value: "10" })).toEqual({ path: "$.db.latency_ms", op: "<", expected: "10", got: "42", pass: false });
    expect(judge(body, { path: "$.nope", op: "exists", value: "" }).got).toBeUndefined();
    const long = judge({ s: "x".repeat(500) }, { path: "$.s", op: "==", value: "y" }).got!;
    expect(long.length).toBe(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("masks what it got, as a snippet is masked, before cutting it", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVlLXRoYXQtaXMtbG9uZw"].join(".");
    expect(judge({ who: "ana@example.com" }, { path: "$.who", op: "==", value: "x" }).got).toBe('"•••"');
    expect(judge({ t: jwt }, { path: "$.t", op: "exists", value: "" }).got).toBe('"•••"');
    expect(judge({ h: "s3cret-value" }, { path: "$.h", op: "==", value: "x" }, ["s3cret-value"]).got).toBe('"•••"');
    // Cut first, the key would keep 27 of its characters, too few for the hex pattern to see.
    expect(judge({ k: `${"x".repeat(70)} ${"a".repeat(70)}` }, { path: "$.k", op: "==", value: "y" }).got).not.toContain("aaaa");
  });

  it("judgeAll keeps the order", () => {
    expect(judgeAll(body, [{ path: "$.status", op: "==", value: "ok" }, { path: "$.db.ok", op: "==", value: "false" }]).map((r) => r.pass)).toEqual([true, false]);
  });
});
