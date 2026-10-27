import { describe, expect, it } from "vitest";
import { judge, parsePath } from "@/checks/assertions";
import { treeOf } from "@/lib/monitor-test";
import { assertionFor, pathOf, type JsonNode } from "@/lib/test-result";

/* Clicking a value of a tested body adds an assertion for it (`docs/flows.md § Testing a
   monitor`). The assertion is only worth adding if the checks read it back as the builder saw it:
   its path must lead to that value, and the value must equal it, through the same parser and the
   same judge the probes use. Every leaf of an awkward body is checked both ways. */

const body = JSON.parse(
  JSON.stringify({
    status: "ok",
    db: { ok: true, latency_ms: 12.5, replicas: [{ lag: 0 }, { lag: -3 }] },
    "a.b": "dotted key",
    'say "hi"': "quoted key",
    "back\\slash": "slashed key",
    "with space": 1,
    "": "empty key",
    "1st": "starts with a digit",
    "dash-ok": "a dash reads after a dot",
    $dollar: "dollar",
    "żółw": "not ASCII",
    numberish: "12",
    boolish: "true",
    nullish: "null",
    quoted: '"ok"',
    objectish: "{}",
    spaced: " padded ",
    blank: "",
    nothing: null,
    big: 1e21,
    list: ["x", 2, false, null, ["nested"]],
  }),
);
// A key JSON.parse gives the object as its own, which a plain object literal wouldn't.
const proto = JSON.parse('{"__proto__": {"polluted": "no"}}');

type Leaf = { steps: (string | number)[]; node: JsonNode };
function leaves(n: JsonNode, steps: (string | number)[] = [], out: Leaf[] = []): Leaf[] {
  if (n.t === "object") for (const e of n.entries) e.masked ? undefined : leaves(e.n, [...steps, e.k], out);
  else if (n.t === "array") n.items.forEach((c, i) => leaves(c, [...steps, i], out));
  else out.push({ steps, node: n });
  return out;
}

describe("pathOf", () => {
  it("writes a path the checks read back to the same steps", () => {
    const all = [...leaves(treeOf(body)), ...leaves(treeOf(proto))];
    expect(all.length).toBeGreaterThan(20);
    for (const { steps } of all) expect(parsePath(pathOf(steps)), pathOf(steps)).toEqual(steps);
  });

  it("uses a dot where it can and brackets where it must", () => {
    expect(pathOf([])).toBe("$");
    expect(pathOf(["db", "replicas", 1, "lag"])).toBe("$.db.replicas[1].lag");
    expect(pathOf(["a.b", 'say "hi"', "back\\slash"])).toBe('$["a.b"]["say \\"hi\\""]["back\\\\slash"]');
    expect(pathOf(["1st", "", "dash-ok"])).toBe('$["1st"][""].dash-ok');
  });
});

describe("assertionFor", () => {
  it("adds an assertion that passes against the body it came from, for every value", () => {
    for (const root of [body, proto]) {
      for (const { steps, node } of leaves(treeOf(root))) {
        const a = { path: pathOf(steps), ...assertionFor(node) };
        expect(judge(root, a).pass, `${a.path} ${a.op} ${a.value}`).toBe(true);
      }
    }
  });

  it("quotes a string that would read as something else, so it stays a string", () => {
    expect(assertionFor({ t: "string", v: "12" })).toEqual({ op: "==", value: '"12"' });
    expect(assertionFor({ t: "string", v: "true" })).toEqual({ op: "==", value: '"true"' });
    expect(assertionFor({ t: "string", v: "null" })).toEqual({ op: "==", value: '"null"' });
    expect(assertionFor({ t: "string", v: "ok" })).toEqual({ op: "==", value: "ok" });
    expect(assertionFor({ t: "number", v: 42 })).toEqual({ op: "==", value: "42" });
    expect(assertionFor({ t: "boolean", v: false })).toEqual({ op: "==", value: "false" });
    expect(assertionFor({ t: "null" })).toEqual({ op: "==", value: "null" });
  });

  it("asks only that the path exists for a value the screen can't show whole", () => {
    const exists = { op: "exists", value: "" };
    expect(assertionFor({ t: "string", v: "•••", masked: true })).toEqual(exists);
    expect(assertionFor({ t: "string", v: "y".repeat(300), cut: true })).toEqual(exists);
    expect(assertionFor({ t: "object", entries: [], more: 0 })).toEqual(exists);
    expect(assertionFor({ t: "array", items: [], more: 0 })).toEqual(exists);
    // Longer than an assertion's value may be once quoted.
    expect(assertionFor({ t: "string", v: "1".repeat(499) })).toEqual(exists);
  });

  it("passes for a masked value too, since the value is there", () => {
    const root = { token: "plain-looking" };
    const [leaf] = leaves(treeOf(root));
    expect(leaf.node).toMatchObject({ masked: true });
    expect(judge(root, { path: pathOf(leaf.steps), ...assertionFor(leaf.node) }).pass).toBe(true);
  });
});
