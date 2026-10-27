import { mask } from "./mask";
import type { AssertionResult } from "./types";

/* Assertions on a JSON body or a heartbeat's fields (`spec.md § 3.1, § 3.3`): `$.db.ok == true`,
   `$.db.latency_ms < 500`, `emails_sent > 0`. The operators are `OPS` in
   `src/lib/monitor-input.ts`, which is where a builder's assertion was validated; this is where it
   is judged.

   Paths are a small JSONPath: `$`, `.key`, `["key"]` or `['key']`, and `[0]`. A heartbeat's field
   may be written without the `$.` (`count`). Values are typed the way a person means them:
   `true`, `12` and `"ok"` are JSON; anything that isn't JSON is a string, so `ok` and `"ok"` mean
   the same. A heartbeat's query parameters arrive as strings, so a number compares with a string
   that holds one. */

export type Assertion = { path: string; op: string; value: string };

type Step = string | number;

export function parsePath(path: string): Step[] | null {
  let p = path.trim();
  if (!p.startsWith("$")) p = `$.${p}`;
  const steps: Step[] = [];
  let i = 1;
  while (i < p.length) {
    if (p[i] === ".") {
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(p.slice(i));
      if (!m) return null;
      steps.push(m[1]);
      i += m[0].length;
    } else if (p[i] === "[") {
      const m = /^\[(?:(\d+)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\]/.exec(p.slice(i));
      if (!m) return null;
      steps.push(m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3]).replace(/\\(.)/g, "$1"));
      i += m[0].length;
    } else return null;
  }
  return steps;
}

export function read(root: unknown, steps: Step[]): unknown {
  let cur: unknown = root;
  for (const s of steps) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (typeof s === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s];
    } else {
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return cur;
}

function typed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function equal(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") return asNumber(actual) === expected;
  if (typeof expected === "boolean" && typeof actual === "string") return actual === String(expected);
  if (expected === null || typeof expected !== "object") {
    if (actual === null || typeof actual !== "object") return actual === expected || (typeof expected === "string" && actual !== undefined && String(actual) === expected);
    return false;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** What the check got, for the incident and the alert: masked like a snippet (`mask.ts`), since
    it is the response's own text, and cut after masking so no half a secret is left. */
const show = (v: unknown, secrets: readonly string[]): string | undefined => {
  if (v === undefined) return undefined;
  const s = mask(JSON.stringify(v) ?? String(v), secrets);
  return s.length > 100 ? `${s.slice(0, 99)}…` : s;
};

export function judge(root: unknown, a: Assertion, secrets: readonly string[] = []): AssertionResult {
  const steps = parsePath(a.path);
  const actual = steps ? read(root, steps) : undefined;
  const expected = typed(a.value);
  let pass = false;
  if (steps) {
    switch (a.op) {
      case "exists":
        pass = actual !== undefined;
        break;
      case "==":
        pass = actual !== undefined && equal(actual, expected);
        break;
      case "!=":
        pass = actual !== undefined && !equal(actual, expected);
        break;
      case "<":
      case ">":
      case "<=":
      case ">=": {
        const x = asNumber(actual);
        const y = asNumber(expected);
        if (x !== null && y !== null) pass = a.op === "<" ? x < y : a.op === ">" ? x > y : a.op === "<=" ? x <= y : x >= y;
        break;
      }
      case "contains": {
        const needle = typeof expected === "string" ? expected : a.value;
        if (typeof actual === "string") pass = actual.includes(needle);
        else if (Array.isArray(actual)) pass = actual.some((el) => equal(el, expected));
        break;
      }
    }
  }
  return { path: a.path, op: a.op, expected: a.value, got: show(actual, secrets), pass };
}

export const judgeAll = (root: unknown, list: readonly Assertion[], secrets: readonly string[] = []) => list.map((a) => judge(root, a, secrets));
