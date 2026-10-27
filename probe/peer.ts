import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Located, Outcome } from "./state";

/* How probes talk to each other: plain HTTP between the boxes, every request signed with a shared
   secret (`x-staygreen-sig: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`) and refused
   outside a 30-second window, so a captured request can't be replayed later.

   - `POST /confirm {monitorId, version}`: check this monitor now, from here, and answer with the
     result; 409 when this probe has the monitor but can't open its secret headers, so can never
     check it as written; 404 when it hasn't loaded the monitor yet, has it paused, or holds
     another version of it than the asker checked, which is no answer, since its copy is up to a
     refresh away from the asker's. The confirmer reads the monitor's config from its own memory;
     a request names a monitor and nothing else, so a forged one could at most cause one extra
     check.
   - `POST /report {outcomes}`: outcomes of checks of monitors this probe is home for, batched.
   - `GET /health`: unsigned, and says nothing a stranger couldn't learn by timing the box. */

export const SIG_HEADER = "x-staygreen-sig";
const WINDOW_SEC = 30;
const MAX_BODY = 1024 * 1024;

export function sign(secret: string, body: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${nowSec}.${body}`).digest("hex");
  return `t=${nowSec},v1=${mac}`;
}

export function verify(secret: string, header: string | undefined, body: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSec - t) > WINDOW_SEC) return false;
  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2], "hex"));
}

/** `version`: the monitor's version the check ran against (`store.ts`, `Monitor`). */
export type Report = { monitorId: string; version: string; outcome: Outcome; atSec: number };

export type PeerHandlers = {
  /** `cannot`: the headers won't open here. Null: not loaded yet, or paused. */
  confirm(monitorId: string, version: string): Promise<Located | "cannot" | null>;
  report(reports: Report[]): void;
  health(): Record<string, unknown>;
};

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export function peerServer(secret: string, h: PeerHandlers): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, h.health());
    if (req.method !== "POST" || (req.url !== "/confirm" && req.url !== "/report")) return send(404);
    const body = await readBody(req);
    if (body === null) return send(413);
    const sig = req.headers[SIG_HEADER];
    if (!verify(secret, Array.isArray(sig) ? sig[0] : sig, body)) return send(401);
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return send(400);
    }
    if (req.url === "/confirm") {
      const { monitorId: id, version } = msg as { monitorId?: unknown; version?: unknown };
      if (typeof id !== "string" || typeof version !== "string") return send(400);
      const result = await h.confirm(id, version);
      if (result === "cannot") return send(409);
      return result ? send(200, { result }) : send(404);
    }
    const reports = (msg as { reports?: unknown }).reports;
    if (!Array.isArray(reports)) return send(400);
    h.report(reports as Report[]);
    return send(204);
  });
}

export type PeerAddress = { id: string; url: string };

async function post(secret: string, peer: PeerAddress, path: string, payload: unknown, timeoutMs: number): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(new URL(path, peer.url), {
    method: "POST",
    headers: { "content-type": "application/json", [SIG_HEADER]: sign(secret, body) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Ask a peer to check a monitor now: its result, `declined` when it answered that it can't open
    this monitor's headers, or null when it gave no answer. */
export async function askConfirm(secret: string, peer: PeerAddress, monitorId: string, version: string, timeoutMs = 25_000): Promise<Located | "declined" | null> {
  try {
    const res = await post(secret, peer, "/confirm", { monitorId, version }, timeoutMs);
    if (res.status === 409) return "declined";
    if (!res.ok) return null;
    return ((await res.json()) as { result: Located }).result;
  } catch {
    return null;
  }
}

export async function sendReports(secret: string, peer: PeerAddress, reports: Report[], timeoutMs = 10_000): Promise<boolean> {
  try {
    // Service observations carry bounded event metadata. Split by bytes, not row count,
    // so two valid large reports cannot leave the outbox retrying a permanent 413.
    let batch: Report[] = [];
    let bytes = Buffer.byteLength('{"reports":[]}');
    for (const report of reports) {
      const size = Buffer.byteLength(JSON.stringify(report));
      if (size + 14 > MAX_BODY) return false;
      if (bytes + size + (batch.length ? 1 : 0) > MAX_BODY) {
        if ((await post(secret, peer, "/report", { reports: batch }, timeoutMs)).status !== 204) return false;
        batch = []; bytes = 14;
      }
      bytes += size + (batch.length ? 1 : 0);
      batch.push(report);
    }
    return !batch.length || (await post(secret, peer, "/report", { reports: batch }, timeoutMs)).status === 204;
  } catch {
    return false;
  }
}
