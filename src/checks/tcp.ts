import net from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { isPublicIp } from "../lib/ip";
import { classify } from "./http";
import { guardedLookup, refusal } from "./lookup";
import { trustContext } from "./tls-context";
import { fail, type AddressGuard, type CheckResult } from "./types";

/* A TCP port (`spec.md § 3.8`): a connection within the timeout (default 10 s), optionally
   completed by a TLS handshake, and slow when that took longer than `slowMs`. The socket is closed
   as soon as it opens; nothing is sent. */

export type TcpCheck = { host: string; port: number; tls?: boolean; timeoutSec?: number; slowMs?: number };
export type TcpOptions = { allow?: AddressGuard; ca?: string | Buffer };

export function checkTcp(c: TcpCheck, o: TcpOptions = {}): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const refused = refusal(c.host, o.allow ?? isPublicIp);
  if (refused) return Promise.resolve(fail(0, "private", refused));

  return new Promise((resolve) => {
    let settled = false;
    const lookup = guardedLookup(o.allow ?? isPublicIp);
    const socket: net.Socket | TLSSocket = c.tls
      ? tls.connect({ host: c.host, port: c.port, servername: net.isIP(c.host) ? undefined : c.host, lookup, secureContext: trustContext(o.ca) })
      : net.connect({ host: c.host, port: c.port, lookup });
    const done = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done(fail(elapsed(), "timeout", `No connection within ${c.timeoutSec ?? 10} s`)), (c.timeoutSec ?? 10) * 1000);
    socket.once(c.tls ? "secureConnect" : "connect", () => {
      const ms = elapsed();
      done({ ok: true, ms, address: socket.remoteAddress, ...(c.slowMs !== undefined && ms > c.slowMs ? { slow: true } : {}) });
    });
    socket.once("error", (err) => {
      const { kind, message } = classify(err);
      done(fail(elapsed(), kind, message));
    });
  });
}
