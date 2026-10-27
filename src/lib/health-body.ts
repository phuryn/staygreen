import { judge, parsePath, read, type Assertion } from "@/checks/assertions";
import { bodyText, mask, maskField } from "@/checks/mask";
import { pathOf } from "./test-result";

/* What a health route's body says, read into assertions a suggested check can carry
   (`docs/flows.md § Suggested checks`). Pure.

   - **Read without a model:** a body in the IETF draft's `application/health+json` shape
     (`draft-inadarei-api-health-check`: `status` of `pass`, `warn` or `fail`), or one of the
     common shapes (`{"status":"ok"}`, Spring Boot's `{"status":"UP"}`, `{"ok":true}`), gets one
     assertion on its top-level status, equal to what it said.
   - **Proposed by the model** (`site-model.ts`): richer ones, a nested component's status or a
     bound on a reported latency. Each goes through `acceptAssertion` first, the same gate the
     deterministic one passes: it must pass on the body just fetched, through the probes' own
     engine (`judge`), and be one a monitor can keep passing while the app is healthy. */

/** What a healthy component says about itself, in the words health routes use. */
export const HEALTHY_WORDS = new Set(["ok", "okay", "pass", "passed", "passing", "up", "healthy", "available", "alive", "ready", "live", "green", "good", "running", "online", "operational", "success", "serving", "connected", "true"]);
/** And an unhealthy one: what a `!=` assertion may rule out. */
export const FAILURE_WORDS = new Set(["fail", "failed", "failing", "failure", "down", "unhealthy", "error", "critical", "red", "offline", "unavailable", "unreachable", "false", "not_serving"]);

/** At most this much of a body is read as JSON: what a suggestion run fetches of a health route. */
export const HEALTH_BODY_BYTES = 8 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The body as JSON, when it is a whole JSON object or array; anything cut short or not JSON is
 *  undefined. */
export function healthJson(body: Uint8Array, truncated: boolean): unknown {
  if (truncated || !body.length || body.length > HEALTH_BODY_BYTES) return undefined;
  try {
    const v: unknown = JSON.parse(bodyText(body));
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A value as the add form writes one (`assertionFor`, `test-result.ts`): a string stays bare
 *  unless it would read as JSON, so it stays a string; anything else is its JSON. */
function written(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v);
  try {
    JSON.parse(v);
    return JSON.stringify(v);
  } catch {
    return v;
  }
}

/** The assertion on the body's top-level status, when it says it is healthy, in the shape it
 *  used. `warn` in the IETF shape is a pass with something to look at, so its assertion is that
 *  the status isn't `fail`. */
export function statusAssertion(json: unknown, contentType: string): Assertion | null {
  if (!isObject(json)) return null;
  const status = json.status;
  let a: Assertion | null = null;
  if (typeof status === "string" && HEALTHY_WORDS.has(status.toLowerCase())) a = { path: "$.status", op: "==", value: written(status) };
  else if (typeof status === "string" && status.toLowerCase() === "warn" && /health\+json/i.test(contentType)) a = { path: "$.status", op: "!=", value: "fail" };
  else if (status === true) a = { path: "$.status", op: "==", value: "true" };
  else {
    const key = ["ok", "healthy", "up", "alive", "ready", "success"].find((k) => json[k] === true);
    if (key) a = { path: `$.${key}`, op: "==", value: "true" };
  }
  return a && acceptAssertion(json, a);
}

/** A key's words: `created_at`, `createdAt` and `created-at` are all `created at`. */
const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Words of a key whose value changes from one request to the next, or from one deploy to the next. */
const VOLATILE = new Set(["timestamp", "ts", "at", "date", "time", "now", "uptime", "version", "commit", "sha", "build", "id", "uuid", "host", "hostname", "pid", "memory", "heap", "rss", "cpu", "count", "total", "size", "bytes", "started", "since", "epoch", "seq", "load"]);
/** Words of a key that holds how long something took. */
const DURATION = new Set(["latency", "latencies", "duration", "elapsed", "took", "rtt", "ping", "lag", "delay", "ms", "millis", "milliseconds"]);
const isVolatile = (w: readonly string[]) => w.some((x) => VOLATILE.has(x));
const isDuration = (w: readonly string[]) => w.some((x) => DURATION.has(x)) || (w.includes("response") && w.includes("time"));
/** What a duration's key may also say, beyond its time: `response_time`, `lastCheckMs`. */
const CHANGING = new Set(["timestamp", "ts", "at", "date", "uptime", "since", "started", "epoch", "count", "total"]);
/** Headroom a latency bound must leave over what was measured. */
const HEADROOM = 2;
const MAX_DEPTH = 6;

/** Words of a key that names a problem rather than a component: `error`, `degraded`, `maintenance`. */
const PROBLEM = new Set(["fail", "failed", "failing", "failure", "failures", "down", "unhealthy", "error", "errors", "critical", "offline", "unavailable", "unreachable", "degraded", "maintenance", "fault", "faults", "exception", "exceptions", "broken", "timeout", "outage", "incident", "incidents"]);
const namesProblem = (w: readonly string[]) => w.some((x) => PROBLEM.has(x));
/** The value a flag holds while the app is healthy: `true`, unless its key names a problem
 *  (`$.degraded`, `$.maintenance`, `$.checks.db.error`). A flag asserted at the other value would
 *  pass while the app is unwell and fail once it recovers. */
const healthyFlag = (w: readonly string[]) => !namesProblem(w);

/** `a`, written the way the add form writes it, when it is one a suggested check may carry; null
 *  when it isn't. A proposal that passes here:
 *  - uses a path the engine reads, at most six steps below the root, and passes on `json` now;
 *  - says something a healthy app keeps saying: equal to a healthy word, not equal to a failure
 *    word, a flag at its healthy value (`healthyFlag`), the existence of a component, or a
 *    latency under a bound with at least twice the room of what was measured;
 *  - never compares a value that changes on its own: a timestamp, an uptime, a version, an id,
 *    a count, a host. */
export function acceptAssertion(json: unknown, a: { path: unknown; op: unknown; value: unknown }): Assertion | null {
  if (typeof a.path !== "string" || typeof a.op !== "string" || typeof a.value !== "string") return null;
  if (a.path.length > 200 || a.value.length > 100) return null;
  const steps = parsePath(a.path);
  if (!steps || !steps.length || steps.length > MAX_DEPTH) return null;
  const actual = read(json, steps);
  if (actual === undefined) return null;
  const key = words([...steps].reverse().find((s): s is string => typeof s === "string") ?? "");
  let expected: unknown;
  try {
    expected = JSON.parse(a.value);
  } catch {
    expected = a.value;
  }
  let value: string;
  switch (a.op) {
    case "==":
      if (typeof actual === "boolean" && typeof expected === "boolean" && expected === healthyFlag(key)) value = String(expected);
      else if (typeof actual === "string" && typeof expected === "string" && HEALTHY_WORDS.has(expected.toLowerCase())) value = written(expected);
      else return null;
      break;
    case "!=":
      if (typeof expected === "string" && FAILURE_WORDS.has(expected.toLowerCase()) && typeof actual === "string") value = written(expected);
      else if (typeof expected === "boolean" && typeof actual === "boolean" && expected !== healthyFlag(key)) value = String(expected);
      else return null;
      break;
    case "<":
    case "<=": {
      if (typeof actual !== "number" || !Number.isFinite(actual) || actual < 0 || typeof expected !== "number" || !Number.isFinite(expected)) return null;
      if (!isDuration(key) || key.some((w) => CHANGING.has(w)) || expected < Math.max(actual * HEADROOM, 1)) return null;
      value = String(expected);
      break;
    }
    case "exists":
      if (!isObject(actual) || namesProblem(key)) return null;
      value = "";
      break;
    default:
      return null;
  }
  if (a.op !== "exists" && a.op !== "<" && a.op !== "<=" && isVolatile(key) && !key.some((w) => /status|state|health/.test(w))) return null;
  const out: Assertion = { path: pathOf(steps), op: a.op, value };
  return judge(json, out).pass ? out : null;
}

/** The body as the model reads it: at most `max` characters of JSON, five levels deep, each
 *  object's first 40 keys and each array's first 5 items, strings cut at 80 characters, and
 *  every value through the masker first, so a key or an address a health route echoes is never
 *  sent anywhere. */
export function bodyForModel(json: unknown, max = 1500): string {
  const prune = (v: unknown, key: string | null, depth: number): unknown => {
    if (typeof v === "string") {
      const m = maskField(key, v);
      return m.length > 80 ? `${m.slice(0, 79)}…` : m;
    }
    if (typeof v !== "object" || v === null) return v;
    if (depth >= 5) return Array.isArray(v) ? [] : {};
    if (Array.isArray(v)) return v.slice(0, 5).map((x) => prune(x, key, depth + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [mask(k).slice(0, 60), prune(x, k, depth + 1)]));
  };
  const text = JSON.stringify(prune(json, null, 0));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
