import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askConfirm, peerServer, sendReports, sign, SIG_HEADER, verify, type Report } from "../../probe/peer";
import type { Located } from "../../probe/state";

/* Probe-to-probe calls: signed with a shared secret, refused outside a 30-second window. */

const SECRET = "test-secret-at-least-32-characters-long";
const result: Located = { ok: false, ms: 12, location: "sfo3", failure: { kind: "status", message: "Answered 503, expected 2xx" } };

let server: Server;
let url = "";
const received: Report[][] = [];

beforeAll(async () => {
  server = peerServer(SECRET, {
    // The asker checked version "v1"; this peer holds "v1" of every monitor it knows.
    confirm: async (id, version) => (version !== "v1" ? null : id === "mon_known" ? result : id === "mon_sealed" ? "cannot" : null),
    report: (reports) => received.push(reports),
    health: () => ({ id: "sfo3-a" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

describe("sign and verify", () => {
  it("round-trips", () => {
    expect(verify(SECRET, sign(SECRET, "body", 1000), "body", 1000)).toBe(true);
  });

  it("refuses another body, another secret, a stale or future time, and junk", () => {
    const sig = sign(SECRET, "body", 1000);
    expect(verify(SECRET, sig, "other", 1000)).toBe(false);
    expect(verify("another-secret-of-enough-length-000", sig, "body", 1000)).toBe(false);
    expect(verify(SECRET, sig, "body", 1031)).toBe(false);
    expect(verify(SECRET, sig, "body", 969)).toBe(false);
    expect(verify(SECRET, sig, "body", 1030)).toBe(true);
    expect(verify(SECRET, undefined, "body", 1000)).toBe(false);
    expect(verify(SECRET, "t=1000,v1=zz", "body", 1000)).toBe(false);
  });
});

describe("the peer server", () => {
  const peer = () => ({ id: "sfo3-a", url });

  it("answers a signed confirm with the check's result", async () => {
    expect(await askConfirm(SECRET, peer(), "mon_known", "v1")).toEqual(result);
  });

  it("says a peer declined a monitor whose headers it can't open, and gives null for one it doesn't hold or a peer that isn't there", async () => {
    expect(await askConfirm(SECRET, peer(), "mon_sealed", "v1")).toBe("declined");
    // Not loaded yet, paused there, or held as another version: its copy may only be a refresh
    // away from the asker's, so that is no answer.
    expect(await askConfirm(SECRET, peer(), "mon_unknown", "v1")).toBeNull();
    expect(await askConfirm(SECRET, peer(), "mon_known", "v2")).toBeNull();
    expect(await askConfirm(SECRET, { id: "x", url: "http://127.0.0.1:1" }, "mon_known", "v1", 2000)).toBeNull();
  });

  it("refuses an unsigned or wrongly signed request", async () => {
    const unsigned = await fetch(`${url}/confirm`, { method: "POST", body: JSON.stringify({ monitorId: "mon_known", version: "v1" }) });
    expect(unsigned.status).toBe(401);
    const body = JSON.stringify({ monitorId: "mon_known", version: "v1" });
    const forged = await fetch(`${url}/confirm`, { method: "POST", body, headers: { [SIG_HEADER]: sign("wrong-secret-of-sufficient-length", body) } });
    expect(forged.status).toBe(401);
    expect(await askConfirm("wrong-secret-of-sufficient-length", peer(), "mon_known", "v1")).toBeNull();
  });

  it("takes signed reports", async () => {
    const reports: Report[] = [{ monitorId: "mon_known", version: "v1", outcome: { first: result }, atSec: 1 }];
    expect(await sendReports(SECRET, peer(), reports)).toBe(true);
    expect(received.at(-1)).toEqual(reports);
  });

  it("refuses a body over 1 MB before reading the signature", async () => {
    const body = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${url}/report`, { method: "POST", body, headers: { [SIG_HEADER]: sign(SECRET, body) } }).catch(() => null);
    if (res) expect(res.status).toBe(413);
  });

  it("splits large service observations into ordered signed requests below the byte ceiling", async () => {
    const before = received.length;
    const reports: Report[] = [1, 2, 3].map(atSec => ({ monitorId: "mon_service", version: "v1", atSec,
      outcome: { first: { ...result, detail: { observation: "x".repeat(600000) } } } }));
    expect(await sendReports(SECRET, peer(), reports)).toBe(true);
    expect(received.slice(before).flat()).toEqual(reports);
    expect(received.slice(before)).toHaveLength(3);
  });

  it("serves /health unsigned, and nothing else", async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ id: "sfo3-a" });
    expect((await fetch(`${url}/anything`)).status).toBe(404);
    expect((await fetch(`${url}/confirm`)).status).toBe(404);
  });
});
