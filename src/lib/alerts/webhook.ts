import { createHmac } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { connect, type TLSSocket } from "node:tls";
import { ipVersion, isPublicIp } from "../ip";
import { linksFor, requestLine, maskAlertText } from "./compose";
import { webhookUrl } from "./channel-input";
import type { Claimed } from "./sender";
import type { SendResult } from "./outcome";

export const WEBHOOK_RETRY_MINUTES = [1, 3, 7, 15, 30] as const;
export const signature = (secret: string, timestamp: number, body: string) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

// Budget after JSON escaping: even legacy evidence with control characters/emoji must fit
// the durable 16 KiB body limit. Seven text fields get at most 1 KiB each, leaving room for
// the fixed schema, ids, dates and the configured dashboard/status links.
function boundedText(text: string): string {
  let out = "", bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes > 1024) break;
    out += char;
  }
  return out;
}

/** Explicit allowlist; never serialize the incident's unbounded evidence or a credential DTO. */
export function webhookPayload(d: Claimed, appUrl: string): string {
  const e = d.incident?.evidence ?? {};
  const clean = (v: unknown) => typeof v === "string" ? boundedText(maskAlertText(v, typeof e.request === "string" ? e.request : undefined)) : undefined;
  // Keep ordinary numeric/boolean assertion results, but hide one that echoes a query secret.
  const got = typeof e.got === "boolean" || typeof e.got === "number" || e.got === null ?
    (clean(String(e.got)) === String(e.got) ? e.got : clean(String(e.got))) : clean(e.got);
  const links = d.incident ? linksFor(appUrl, d.incident.id, d.pageSlug) : null;
  const warning = d.incident?.severity !== "down";
  const expiry = e.kind === "expiry" || e.source === "expiry" || d.monitor?.type === "ssl";
  return JSON.stringify({
    id: d.id,
    event: d.event === "test" ? "test" : d.event === "resolved" ? (warning ? "monitor.recovered" : "incident.resolved") :
      warning ? (expiry ? "expiry.reminder" : "monitor.degraded") : "incident.opened",
    incident: d.incident ? { id: d.incident.id, started_at: new Date(d.incident.openedAt).toISOString(),
      severity: d.incident.severity, ...(d.incident.resolvedAt ? { resolved_at: new Date(d.incident.resolvedAt).toISOString() } : {}) } : null,
    app: clean(d.app?.name) ?? null,
    monitor: d.monitor ? { id: d.monitor.id, type: d.monitor.type, name: clean(d.monitor.name) } : null,
    evidence: { status: typeof e.status === "number" ? e.status : undefined, request: typeof e.request === "string" ? boundedText(requestLine(e.request)) : undefined,
      summary: clean(e.summary), assertion: clean(e.assertion),
      got,
      locations: Array.isArray(e.locations) ? e.locations.filter((v) => typeof v === "string" && ["tor1", "sfo3", "fra1"].includes(v)) : [],
      snippet: clean(e.snippet) },
    links: { incident: links?.incidentUrl ?? null, status_page: links?.pageUrl ?? null },
  });
}

export type ResolveWebhook = (host: string) => Promise<string[]>;
export const resolveWebhook: ResolveWebhook = async (host) => {
  const answers = await Promise.all([resolve4(host), resolve6(host)].map(async (p) => {
    try { return await p; } catch (e) {
      if (["ENODATA", "ENOTFOUND"].includes((e as NodeJS.ErrnoException).code ?? "")) return [];
      throw new Error("DNS unavailable");
    }
  }));
  return answers.flat();
};

export type WebhookTransport = (url: string, body: string, headers: Record<string, string>) => Promise<SendResult>;

/** Connect to a checked literal, with the original Host and TLS identity. Workers' node:https
 *  wraps fetch and ignores lookup, so reusing checkHttp here would NOT pin the connection.
 *  No redirects; no response body is read or logged. Works in Node and Workers node:tls. */
export function pinnedWebhookTransport(resolve: ResolveWebhook = resolveWebhook, dial: typeof connect = connect): WebhookTransport {
  return async (address, body, headers) => {
    const u = webhookUrl(address);
    if (!u) return { kind: "rejected", code: 400, detail: "Webhook requires a public HTTPS address on port 443." };
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: TLSSocket | undefined;
    try {
      return await Promise.race([
        new Promise<SendResult>((done) => { timer = setTimeout(() => { socket?.destroy(); done({ kind: "retry", detail: "Webhook did not answer within ten seconds." }); }, 10_000); }),
        (async (): Promise<SendResult> => {
          const ips = ipVersion(host) ? [host] : await resolve(host);
          if (!ips.length || ips.some((ip) => !isPublicIp(ip))) return { kind: "rejected", code: 400, detail: "Webhook address did not resolve exclusively to public addresses." };
          // DNS may have finished after the deadline; never start a late connection.
          if (timer === undefined) return { kind: "retry", detail: "Webhook DNS timed out." };
          return await new Promise<SendResult>((done) => {
            let head = Buffer.alloc(0);
            socket = dial({ host: ips[0], port: 443, servername: host, rejectUnauthorized: true }, () => {
              if (!socket?.authorized) { socket?.destroy(); done({ kind: "rejected", code: 400, detail: "Webhook TLS identity could not be verified." }); return; }
              socket.write(`POST ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`);
            });
            socket.on("error", () => done({ kind: "retry", detail: "Webhook connection failed." }));
            socket.on("end", () => done({ kind: "retry", detail: "Webhook closed before confirming acceptance." }));
            socket.on("data", (chunk: Buffer) => {
              head = Buffer.concat([head, chunk.subarray(0, 16_385 - head.length)]);
              let end = head.indexOf("\r\n\r\n");
              if (end < 0 && head.length > 16_384) { socket?.destroy(); done({ kind: "retry", detail: "Webhook response headers were too large." }); return; }
              while (end >= 0) {
                const status = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/.exec(head.toString("latin1"));
                const code = status ? Number(status[1]) : 0;
                if (code >= 100 && code < 200 && code !== 101) { head = head.subarray(end + 4); end = head.indexOf("\r\n\r\n"); continue; }
                socket?.destroy();
                done(code >= 200 && code < 300 ? { kind: "sent", messageId: headers["Idempotency-Key"], redirected: false } :
                  code >= 300 && code < 500 && code !== 408 && code !== 429 ? { kind: "rejected", code, detail: "Webhook refused the delivery. Redirects are not followed." } :
                    { kind: "retry", detail: "Webhook did not accept the delivery." });
                return;
              }
            });
          });
        })(),
      ]);
    } catch { return { kind: "retry", detail: "Webhook could not be reached." }; }
    finally { clearTimeout(timer); timer = undefined; socket?.destroy(); }
  };
}

export const sendWebhook = (transport: WebhookTransport, url: string, secret: string, id: string, body: string, now: number) =>
  transport(url, body, { "Staygreen-Signature": signature(secret, Math.floor(now / 1000), body), "Idempotency-Key": id });
