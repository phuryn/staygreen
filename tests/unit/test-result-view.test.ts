import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assertionKey, TestResult, testSummary, type TreeProps } from "@/components/TestResult";
import { treeOf } from "@/lib/monitor-test";
import type { TestOutcome } from "@/lib/test-result";

/* What the form shows after a test (`src/components/TestResult.tsx`). The browser suite can't
   reach a target that answers (the guard refuses this machine, and the suites reach no outside
   host on purpose), so the screen is rendered here: the verdict in shape and word as well as
   colour, where it ran from, and the JSON tree whose values are buttons a keyboard reaches. */

const http = (over: Partial<Extract<TestOutcome, { type: "http" }>["http"]> = {}, verdict: Partial<TestOutcome> = {}): TestOutcome =>
  ({
    ok: true,
    ms: 142,
    at: Date.parse("2026-10-22T09:00:00Z"),
    timeoutSec: 15,
    ...verdict,
    type: "http",
    http: {
      url: "https://api.example.com/health",
      method: "GET",
      expect: "2xx",
      slowMs: 3000,
      status: 200,
      statusOk: true,
      address: "93.184.216.34",
      redirects: [],
      headers: [["content-type", "application/json"]],
      body: { bytes: 60, truncated: false, contentType: "application/json", kind: "json", text: "{}", json: treeOf({ status: "ok", db: { ok: true }, token: "plain-looking" }) },
      assertions: [],
      ...over,
    },
  }) as TestOutcome;

const tree = (over: Partial<TreeProps> = {}): TreeProps => ({ onPick: () => {}, picked: new Set(), full: false, ...over });
const render = (outcome: TestOutcome, t?: TreeProps, stale = false) => renderToStaticMarkup(createElement(TestResult, { outcome, from: "Toronto or San Francisco", stale, tree: t }));

describe("TestResult", () => {
  it("says where it ran: once, from Staygreen's server, not the monitor's locations", () => {
    expect(render(http())).toContain("from Staygreen&#x27;s own server, not from Toronto or San Francisco.");
    expect(render(http(), undefined, true)).toContain("You&#x27;ve changed the form since; test again");
  });

  it("gives the verdict a shape and a word as well as a colour", () => {
    expect(render(http())).toMatch(/state-icon up.*<strong>Passed<\/strong>/s);
    expect(render(http({}, { slow: true }))).toMatch(/state-icon degraded.*<strong>Passed, but slow<\/strong>/s);
    const failed = render(http({ status: 503, statusOk: false }, { ok: false, failure: { kind: "status", message: "Answered 503, expected 2xx" } }));
    expect(failed).toMatch(/state-icon down.*<strong>Failed<\/strong>/s);
    expect(failed).toContain("callout callout-down");
    expect(failed).toContain("503, expected 2xx");
  });

  it("makes every reachable value of a JSON body a button that names the assertion it adds", () => {
    const html = render(http(), tree());
    expect(html).toContain('<button type="button" class="jt-val" aria-pressed="false" aria-label="Check $.status == ok">&quot;ok&quot;</button>');
    expect(html).toContain('aria-label="Check $.db.ok == true"');
    // A masked value can still be asked to exist; its value can't be asserted.
    expect(html).toContain('aria-label="Check $.token exists">&quot;•••&quot;</button>');
  });

  it("presses a value already checked, and offers to take it off", () => {
    const html = render(http(), tree({ picked: new Set([assertionKey("$.status", "==", "ok")]) }));
    expect(html).toContain('aria-pressed="true" aria-label="Stop checking $.status == ok"');
  });

  it("disables the values not yet checked once the plan's assertions are used, and says why", () => {
    const html = render(http(), tree({ full: true, picked: new Set([assertionKey("$.status", "==", "ok")]) }));
    expect(html).toContain("Every assertion your plan has is in use");
    expect(html).toContain('disabled="" aria-label="Check $.db.ok == true"');
    expect(html).not.toContain('disabled="" aria-label="Stop checking $.status == ok"');
  });

  it("shows a value under a key the masker hid as text, never as something to assert", () => {
    const key = ["sk_", "live_", "0123456789abcdefABCDEF"].join("");
    const html = render(http({ body: { bytes: 10, truncated: false, contentType: "application/json", kind: "json", text: "{}", json: treeOf({ [key]: 1 }) } }), tree());
    expect(html).not.toContain(key);
    expect(html).toContain('<span class="jt-val jt-fixed">1</span>');
    expect(html).not.toContain("<button");
  });

  it("names an assertion's result in words beside its mark, and what it got", () => {
    const html = render(http({ assertions: [{ path: "$.db.ok", op: "==", expected: "false", got: "true", pass: false }] }));
    expect(html).toContain('<title>Failing</title>');
    expect(html).toContain("got true");
  });

  it("says a body was cut at 64 KB", () => {
    expect(render(http({ body: { bytes: 65536, truncated: true, contentType: "text/plain", kind: "text", text: "x" } }))).toContain("first 64 KB and stops");
  });

  it("reads each DNS resolver against what is expected", () => {
    const html = render({
      ok: true, ms: 40, at: 0, timeoutSec: 10, type: "dns",
      dns: { record: "A", name: "example.com", expected: "1.2.3.4", resolvers: [
        { id: "cloudflare", label: "Cloudflare (1.1.1.1)", answers: ["1.2.3.4"], matches: true },
        { id: "google", label: "Google (8.8.8.8)", error: "No record of this type", matches: false },
      ] },
    });
    expect(html).toContain("<title>Matches</title>");
    expect(html).toContain("<title>Doesn&#x27;t match</title>");
    expect(html).toContain("No record of this type");
  });
});

describe("testSummary", () => {
  it("is what a screen reader hears when the test answers", () => {
    expect(testSummary(http())).toBe("Test passed in 142 ms.");
    expect(testSummary(http({}, { ok: false, failure: { kind: "timeout", message: "No answer within 15 s" } }))).toBe("Test failed in 142 ms. No answer within 15 s.");
  });
});
