import { describe, expect, it } from "vitest";
import { heartbeatIntervalSec } from "@/lib/cron";
import { judge } from "@/checks/assertions";
import { CREATABLE, defaultName, DNS_RECORDS, hostOf, isCreatable, maskedAssertion, METHODS, OPS, parseMonitorDraft, type MonitorDraft, type ParseResult } from "@/lib/monitor-input";
import { maskPayload } from "../../ingest/src/handler";

/* What a builder may submit as a new monitor (`src/lib/monitor-input.ts`), run
   by the form and again by the creating action, because the form is a proposal
   (`AGENTS.md § 1.2`). A refusal is keyed by the form's own field names. */

const APP = "app_0123456789abcdef01234567";

const http = (over: Partial<Extract<MonitorDraft, { type: "http" }>> = {}): MonitorDraft => ({
  type: "http",
  appId: APP,
  name: "",
  url: "https://api.example.com/health",
  method: "GET",
  expect: "2xx",
  keyword: "",
  slowMs: 2000,
  assertions: [],
  headers: [],
  ...over,
});
const ssl = (host: string, name = ""): MonitorDraft => ({ type: "ssl", appId: APP, name, host });
const tcp = (host: string, port = 5432, tls = false): MonitorDraft => ({ type: "tcp", appId: APP, name: "", host, port, tls });
const dns = (over: Partial<Extract<MonitorDraft, { type: "dns" }>> = {}): MonitorDraft => ({ type: "dns", appId: APP, name: "", record: "A", recordName: "www.example.com", expected: "93.184.216.34", ...over });
const heartbeat = (over: Partial<Extract<MonitorDraft, { type: "heartbeat" }>> = {}): MonitorDraft => ({
  type: "heartbeat",
  appId: APP,
  name: "",
  schedule: "0 6 * * *",
  tz: "Europe/Warsaw",
  graceMin: 5,
  maxRunMin: 60,
  assertions: [],
  ...over,
});

function row(r: ParseResult) {
  if (!r.ok) throw new Error(`expected a row, got ${JSON.stringify(r.fieldErrors)}`);
  return r.row;
}
function errors(r: ParseResult) {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.row)}`);
  return r.fieldErrors;
}
/** The fields a refusal names, in a stable order. */
const fields = (r: ParseResult) => Object.keys(errors(r)).sort();

describe("the constants", () => {
  it("lets the seven built types be created", () => {
    expect([...CREATABLE]).toEqual(["http", "ssl", "dns", "tcp", "heartbeat", "stripe", "supabase"]);
    for (const t of CREATABLE) expect(isCreatable(t)).toBe(true);
    for (const t of ["mcp", "HTTP", ""]) expect(isCreatable(t)).toBe(false);
  });

  it("names the methods, records and comparisons the form offers", () => {
    expect([...METHODS]).toEqual(["GET", "HEAD", "POST"]);
    expect([...DNS_RECORDS]).toEqual(["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "NS"]);
    expect([...OPS]).toEqual(["==", "!=", "<", ">", "<=", ">=", "contains", "exists"]);
  });
});

describe("http", () => {
  it("becomes the row create_monitor takes", () => {
    const r = parseMonitorDraft(
      http({
        keyword: "ok",
        assertions: [
          { path: "$.db.ok", op: "==", value: "true" },
          { path: "$.queue", op: "exists", value: "ignored" },
        ],
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      }),
    );
    expect(row(r)).toStrictEqual({
      type: "http",
      appId: APP,
      name: "Health",
      target: "https://api.example.com/health",
      targetHost: "api.example.com",
      config: {
        method: "GET",
        expect: "2xx",
        keyword: "ok",
        slowMs: 2000,
        timeoutSec: 15,
        assertions: [
          { path: "$.db.ok", op: "==", value: "true" },
          { path: "$.queue", op: "exists", value: "" },
        ],
      },
      secrets: [{ name: "Authorization", value: "Bearer secret" }],
      fixedIntervalSec: null,
    });
  });

  it("stores an empty keyword as none, and keeps a name the builder gave", () => {
    const r = row(parseMonitorDraft(http({ name: "  API health  " })));
    expect(r.name).toBe("API health");
    expect(r.config.keyword).toBeNull();
  });

  it.each(["https://1.1.1.1/", "https://[2606:4700:4700::1111]:8443/x"])("accepts a public IP literal: %s", (url) => {
    const r = row(parseMonitorDraft(http({ url })));
    expect(r.targetHost).toBe(hostOf(url));
    expect(r.targetHost).not.toMatch(/[[\]]/);
  });

  it.each([
    "http://10.0.0.1/",
    "http://127.0.0.1:3000/",
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://printer.local/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://intranet/",
  ])("refuses the private target %s on the url field, naming the host", (url) => {
    const r = parseMonitorDraft(http({ url }));
    expect(fields(r)).toEqual(["url"]);
    expect(errors(r).url).toContain(hostOf(url));
  });

  // WHATWG URL rewrites these to 127.0.0.1 before the host is judged.
  it.each(["http://0x7f.0.0.1/", "http://2130706433/", "http://0177.0.0.1/", "http://127.1/", "http://LOCALHOST./"])("refuses the disguised loopback %s", (url) => {
    expect(fields(parseMonitorDraft(http({ url })))).toEqual(["url"]);
  });

  it.each(["ftp://example.com/", "javascript:alert(1)", "example.com/health", "", "https://"])("refuses %j as not a full http(s) address", (url) => {
    expect(fields(parseMonitorDraft(http({ url })))).toEqual(["url"]);
  });

  it("refuses credentials in the address", () => {
    expect(fields(parseMonitorDraft(http({ url: "https://user:pass@api.example.com/" })))).toEqual(["url"]);
  });

  it.each([
    [{ expect: "200 OK" }, "expect"],
    [{ expect: "600" }, "expect"],
    [{ slowMs: 99 }, "slowMs"],
    [{ slowMs: 60_001 }, "slowMs"],
    [{ slowMs: 1.5 }, "slowMs"],
    [{ method: "DELETE" as never }, "method"],
    [{ keyword: "k".repeat(201) }, "keyword"],
    [{ url: `https://example.com/${"a".repeat(2048)}` }, "url"],
    [{ name: "n".repeat(81) }, "name"],
    [{ appId: "app_123" }, "appId"],
    [{ assertions: [{ path: "", op: "==", value: "x" }] }, "asserts"],
    [{ assertions: [{ path: "$.ok", op: "~=" as never, value: "x" }] }, "asserts"],
    [{ assertions: Array.from({ length: 11 }, () => ({ path: "$.ok", op: "exists" as const, value: "" })) }, "asserts"],
  ] as [Partial<Extract<MonitorDraft, { type: "http" }>>, string][])("refuses %j on the %s field", (over, field) => {
    expect(fields(parseMonitorDraft(http(over)))).toEqual([field]);
  });

  it.each([
    [[{ name: "X Bad Name", value: "v" }]],
    [[{ name: "Host", value: "evil.example" }]],
    [[{ name: "content-length", value: "0" }]],
    [[{ name: "Transfer-Encoding", value: "chunked" }]],
    [[{ name: "Connection", value: "close" }]],
    [[{ name: "X-Key", value: "a" }, { name: "x-key", value: "b" }]],
    [[{ name: "X-Key", value: "" }]],
    [[{ name: "X-Key", value: "a\r\nX-Injected: 1" }]],
    [[{ name: "X-Key", value: "v".repeat(4097) }]],
    [[{ name: "X-Key", value: "“pasted”" }]],
    [[{ name: "X-Key", value: "a\u0007b" }]],
    [Array.from({ length: 11 }, (_, i) => ({ name: `X-H${i}`, value: "v" }))],
  ])("refuses the secret headers %j on the headers field", (headers) => {
    expect(fields(parseMonitorDraft(http({ headers })))).toEqual(["headers"]);
  });

  it("takes any header value Node will send, Latin-1 included", () => {
    expect(parseMonitorDraft(http({ headers: [{ name: "X-Key", value: "café \tkey" }] })).ok).toBe(true);
  });

  it("editing, keeps a stored header sent with no value, and only a stored one", () => {
    const stored = { storedHeaders: ["Authorization"] };
    const kept = parseMonitorDraft(http({ headers: [{ name: "Authorization", value: "" }] }), stored);
    expect(kept.ok && kept.row.secrets).toEqual([{ name: "Authorization", value: "" }]);
    expect(fields(parseMonitorDraft(http({ headers: [{ name: "X-Key", value: "" }] }), stored))).toEqual(["headers"]);
    // The stored name is matched exactly, and the other checks still run.
    expect(fields(parseMonitorDraft(http({ headers: [{ name: "authorization", value: "" }] }), stored))).toEqual(["headers"]);
    expect(fields(parseMonitorDraft(http({ headers: [{ name: "Authorization", value: "" }, { name: "authorization", value: "b" }] }), stored))).toEqual(["headers"]);
  });
});

describe("ssl", () => {
  it("becomes a six-hourly certificate check on the bare host", () => {
    expect(row(parseMonitorDraft(ssl("Example.COM.")))).toStrictEqual({
      type: "ssl",
      appId: APP,
      name: "example.com",
      target: "example.com",
      targetHost: "example.com",
      config: { host: "example.com" },
      secrets: [],
      fixedIntervalSec: 21600,
    });
  });

  it.each(["https://example.com", "example.com:443", "1.1.1.1", "localhost", "under_score.example.com", ""])("refuses %j on the host field: a certificate needs a hostname", (host) => {
    expect(fields(parseMonitorDraft(ssl(host)))).toEqual(["host"]);
  });

  it("refuses a name only a private network answers, naming it", () => {
    const r = parseMonitorDraft(ssl("printer.local"));
    expect(fields(r)).toEqual(["host"]);
    expect(errors(r).host).toContain("printer.local");
  });
});

describe("tcp", () => {
  it("becomes a host:port target", () => {
    expect(row(parseMonitorDraft(tcp("DB.Example.com", 5432, true)))).toStrictEqual({
      type: "tcp",
      appId: APP,
      name: "db.example.com port 5432",
      target: "db.example.com:5432",
      targetHost: "db.example.com",
      config: { host: "db.example.com", port: 5432, tls: true, slowMs: 1000 },
      secrets: [],
      fixedIntervalSec: null,
    });
  });

  it("is slow above a second unless the builder says otherwise, within the same bounds as HTTP", () => {
    expect(row(parseMonitorDraft({ ...tcp("db.example.com"), slowMs: 2500 })).config).toMatchObject({ slowMs: 2500 });
    const r = parseMonitorDraft({ ...tcp("db.example.com"), slowMs: 50 });
    expect(r.ok ? null : r.fieldErrors.slowMs).toBe("Between 100 and 60,000 ms");
  });

  it.each(["1.1.1.1", "2606:4700:4700::1111"])("accepts the public IP %s", (host) => {
    expect(row(parseMonitorDraft(tcp(host))).targetHost).toBe(host);
  });

  it.each(["10.0.0.4", "127.0.0.1", "::1", "::ffff:192.168.0.1", "169.254.169.254", "redis.internal", "localhost"])("refuses the private host %s, naming it", (host) => {
    const r = parseMonitorDraft(tcp(host));
    expect(fields(r)).toEqual(["host"]);
    if (host.includes(".") || host.includes(":")) expect(errors(r).host).toContain(host);
  });

  it.each(["0x7f.0.0.1", "2130706433", "127.1", "[::1]", "db.example.com:5432", "tcp://db.example.com"])("refuses %j as not a hostname or an address", (host) => {
    expect(fields(parseMonitorDraft(tcp(host)))).toEqual(["host"]);
  });

  it.each([0, 65536, 22.5, -1])("refuses port %s", (port) => {
    expect(fields(parseMonitorDraft(tcp("db.example.com", port)))).toEqual(["port"]);
  });
});

describe("dns", () => {
  it("becomes a ten-minute record check, the name lowercased and its trailing dot stripped", () => {
    expect(row(parseMonitorDraft(dns({ recordName: "  WWW.Example.COM.  " })))).toStrictEqual({
      type: "dns",
      appId: APP,
      name: "www.example.com A",
      target: "A www.example.com",
      targetHost: "www.example.com",
      config: { record: "A", name: "www.example.com", expected: "93.184.216.34" },
      secrets: [],
      fixedIntervalSec: 600,
    });
  });

  it("accepts underscore labels and counts the record against the host it belongs to", () => {
    const r = row(parseMonitorDraft(dns({ record: "TXT", recordName: "_dmarc.example.com", expected: "v=DMARC1; p=none" })));
    expect(r.config.name).toBe("_dmarc.example.com");
    expect(r.targetHost).toBe("example.com");
    expect(row(parseMonitorDraft(dns({ record: "TXT", recordName: "_sip._tcp.example.com", expected: "x" }))).targetHost).toBe("example.com");
  });

  it.each(DNS_RECORDS)("accepts a %s record", (record) => {
    expect(row(parseMonitorDraft(dns({ record, ...(record === "NS" ? { expected: "ns1.example.net, ns2.example.net" } : {}) }))).config.record).toBe(record);
  });

  it.each(["printer.local", "db.internal", "x.localhost."])("refuses %s on the dnsName field: public resolvers cannot answer for it", (recordName) => {
    const r = parseMonitorDraft(dns({ recordName }));
    expect(fields(r)).toEqual(["dnsName"]);
    expect(errors(r).dnsName).toContain(recordName.toLowerCase().replace(/\.$/, ""));
  });

  it.each(["not a name", "example", "http://example.com", "", "-bad.example.com"])("refuses %j on the dnsName field", (recordName) => {
    expect(fields(parseMonitorDraft(dns({ recordName })))).toEqual(["dnsName"]);
  });

  it("refuses a missing or overlong expected value on the dnsExpected field", () => {
    expect(fields(parseMonitorDraft(dns({ expected: "   " })))).toEqual(["dnsExpected"]);
    expect(fields(parseMonitorDraft(dns({ expected: "x".repeat(501) })))).toEqual(["dnsExpected"]);
  });

  it("refuses a record type the form does not offer", () => {
    expect(fields(parseMonitorDraft(dns({ record: "SRV" as never })))).toEqual(["record"]);
  });
});

describe("heartbeat", () => {
  it("becomes a row whose interval is derived from the schedule", () => {
    expect(row(parseMonitorDraft(heartbeat({ assertions: [{ path: "rows", op: ">", value: "0" }] })))).toStrictEqual({
      type: "heartbeat",
      appId: APP,
      name: "Scheduled job",
      target: "in.staygreen.io",
      targetHost: null,
      config: { schedule: "0 6 * * *", tz: "Europe/Warsaw", graceMin: 5, maxRunMin: 60, assertions: [{ path: "rows", op: ">", value: "0" }] },
      secrets: [],
      fixedIntervalSec: heartbeatIntervalSec("0 6 * * *"),
    });
    expect(row(parseMonitorDraft(heartbeat({ schedule: "*/5 * * * *" }))).fixedIntervalSec).toBe(300);
  });

  it.each([
    [{ schedule: "every day" }, "cron"],
    [{ schedule: "0 6 * *" }, "cron"],
    [{ tz: "Mars/Olympus_Mons" }, "tz"],
    [{ graceMin: 0 }, "grace"],
    [{ graceMin: 1441 }, "grace"],
    [{ maxRunMin: 0 }, "maxRun"],
    [{ maxRunMin: 1441 }, "maxRun"],
    [{ assertions: [{ path: " ", op: "==", value: "1" }] }, "asserts"],
  ] as [Partial<Extract<MonitorDraft, { type: "heartbeat" }>>, string][])("refuses %j on the %s field", (over, field) => {
    expect(fields(parseMonitorDraft(heartbeat(over)))).toEqual([field]);
  });
});

describe("a heartbeat's assertions and the receiver's masking", () => {
  // Each refused assertion with the payload a job would send for it to pass: masked as the
  // receiver masks it, it would fail for ever. The rule: an assertion never fails because of the
  // masking, so it can't be saved.
  const defeated: [string, string, string, Record<string, unknown>][] = [
    ["to", "==", "ops@example.com", { to: "ops@example.com" }],
    ["to", "contains", "@example.com", { to: "ops@example.com" }],
    ["commit", "==", "0123456789abcdef0123456789abcdef01234567", { commit: "0123456789abcdef0123456789abcdef01234567" }],
    ["commit", "contains", "0123abc", { commit: "0123abcdef0123456789abcdef0123456789abcd" }],
    ["token", "==", "abc", { token: "abc" }],
    ["password", "==", "hunter2", { password: "hunter2" }],
    ["api_key", ">", "0", { api_key: 5 }],
    ["session.expires", "exists", "", { session: { expires: 1 } }],
    ["$['ops@example.com']", "exists", "", { "ops@example.com": 1 }],
  ];

  it.each(defeated)("refuses %s %s %j, which the masked payload could never pass, saying why on the assertions field", (path, op, value, payload) => {
    expect(judge(payload, { path, op, value }).pass).toBe(true);
    expect(judge(maskPayload(payload), { path, op, value }).pass).toBe(false);
    const e = errors(parseMonitorDraft(heartbeat({ assertions: [{ path, op: op as never, value }] })));
    expect(Object.keys(e)).toEqual(["asserts"]);
    expect(e.asserts).toMatch(/hidden|hides/);
    expect(e.asserts).toMatch(/instead|plain name|another name/);
  });

  // Each kept one passes on the masked payload exactly as on the one the job sent.
  const kept: [string, string, string, Record<string, unknown>][] = [
    ["token", "exists", "", { token: "abc" }],
    ["emails_sent", ">", "0", { emails_sent: 12, to: "ops@example.com" }],
    ["subject", "contains", "Daily report", { subject: "Daily report for ops@example.com" }],
    ["status", "==", "ok", { status: "ok", key: "sk_live_0123456789abcdefghij" }],
    ["build", "==", "1234", { build: 1234 }],
  ];

  it.each(kept)("keeps %s %s %j, which holds on the masked payload as on the sent one", (path, op, value, payload) => {
    expect(maskedAssertion({ path, op, value })).toBeNull();
    expect(judge(maskPayload(payload), { path, op, value }).pass).toBe(judge(payload, { path, op, value }).pass);
    expect(judge(maskPayload(payload), { path, op, value }).pass).toBe(true);
    expect(parseMonitorDraft(heartbeat({ assertions: [{ path, op: op as never, value }] })).ok).toBe(true);
  });

  it("leaves an HTTP check's assertions alone: a response body is judged before it is masked", () => {
    expect(parseMonitorDraft(http({ assertions: [{ path: "$.owner", op: "==", value: "ops@example.com" }] })).ok).toBe(true);
  });
});

describe("what is not a draft", () => {
  it.each(["mcp", "ping"])("refuses the type %s on the type field", (type) => {
    expect(fields(parseMonitorDraft({ ...http(), type }))).toEqual(["type"]);
  });

  it.each([null, undefined, "https://example.com", 42, []])("refuses %j with a form-level error", (raw) => {
    expect(fields(parseMonitorDraft(raw))).toEqual(["form"]);
  });

  it("names every refused field at once, each with one message", () => {
    const r = parseMonitorDraft(http({ appId: "nope", expect: "x", slowMs: 1, assertions: [{ path: "", op: "==", value: "" }] }));
    expect(fields(r)).toEqual(["appId", "asserts", "expect", "slowMs"]);
    for (const message of Object.values(errors(r))) expect(typeof message === "string" && message.length > 0).toBe(true);
  });
});

describe("defaultName and hostOf", () => {
  it.each([
    ["https://api.example.com/", "Website"],
    ["https://api.example.com", "Website"],
    ["https://api.example.com/api/health-check", "Health check"],
    ["https://api.example.com/v1/ready_now?x=1#top", "Ready now"],
    ["https://api.example.com/caf%C3%A9", "Café"],
    ["https://api.example.com/bad%E0%A4%A", "Bad%E0%A4%A"],
  ])("names %s %j", (url, name) => {
    expect(defaultName(url)).toBe(name);
  });

  it("keeps a suggested name within the 80 characters a name may have", () => {
    expect(defaultName(`https://example.com/${"a".repeat(200)}`)).toHaveLength(80);
  });

  it.each([
    ["https://API.Example.com/x", "api.example.com"],
    ["api.example.com/health", "api.example.com"],
    ["https://[2606:4700::1111]:443/", "2606:4700::1111"],
    ["https://example.com./", "example.com"],
    ["https://", ""],
  ])("hostOf(%j) is %j", (url, host) => {
    expect(hostOf(url)).toBe(host);
  });
});
