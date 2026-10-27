import net from "node:net";
import tls, { type PeerCertificate } from "node:tls";
import { isPublicIp } from "../lib/ip";
import { classify } from "./http";
import { guardedLookup, refusal } from "./lookup";
import { trustContext } from "./tls-context";
import { fail, type AddressGuard, type CheckResult } from "./types";

/* A host's certificate (`spec.md § 3.2`): the chain, the hostname and the days to expiry. An
   invalid chain, a hostname mismatch or an expired certificate is a `cert` failure, settled at once; the reminders
   at 21, 7 and 1 days are the alerting layer's, read from `detail.daysLeft` on a passing check.

   The handshake runs with verification off so a bad certificate can still be read and described;
   the verdict is then made here, from `authorized` and Node's own hostname check. */

export type CertCheck = { host: string; port?: number; timeoutSec?: number };
export type CertOptions = {
  allow?: AddressGuard;
  ca?: string | Buffer;
  now?: () => number;
  /** Sees the certificate and Node's own verdict on it, for the dashboard's test of a monitor,
   *  which shows the names it covers (`src/lib/monitor-test.ts`). The probes pass none. */
  observe?: (seen: { cert: PeerCertificate; authorized: boolean; authorizationError?: string }) => void;
};

const DAY = 86_400_000;

export function checkCert(c: CertCheck, o: CertOptions = {}): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const refused = refusal(c.host, o.allow ?? isPublicIp);
  if (refused) return Promise.resolve(fail(0, "private", refused));

  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: c.host,
      port: c.port ?? 443,
      servername: net.isIP(c.host) ? undefined : c.host,
      lookup: guardedLookup(o.allow ?? isPublicIp),
      rejectUnauthorized: false,
      secureContext: trustContext(o.ca),
    });
    const done = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done(fail(elapsed(), "timeout", `No TLS handshake within ${c.timeoutSec ?? 15} s`)), (c.timeoutSec ?? 15) * 1000);
    socket.once("secureConnect", () => {
      const cert: PeerCertificate = socket.getPeerCertificate();
      const ms = elapsed();
      o.observe?.({ cert, authorized: socket.authorized, authorizationError: socket.authorized ? undefined : String(socket.authorizationError) });
      if (!cert || !cert.valid_to) return done(fail(ms, "cert", "The server sent no certificate"));
      const expires = Date.parse(cert.valid_to);
      const now = (o.now ?? Date.now)();
      const daysLeft = Math.floor((expires - now) / DAY);
      const detail = { daysLeft, expiresAt: new Date(expires).toISOString(), issuer: cert.issuer?.O ?? cert.issuer?.CN ?? null, subject: cert.subject?.CN ?? null };
      if (expires <= now) return done(fail(ms, "cert", `The certificate expired on ${detail.expiresAt.slice(0, 10)}`, { detail }));
      // Node reports a hostname mismatch as unauthorized too; it is told apart, so the builder
      // reads which of the two is wrong.
      const why = socket.authorized ? null : String(socket.authorizationError);
      if (why && !/ALTNAME/.test(why)) return done(fail(ms, "cert", `The certificate chain isn't trusted (${why})`, { detail }));
      const mismatch = net.isIP(c.host) ? undefined : tls.checkServerIdentity(c.host, cert);
      if (mismatch || why) return done(fail(ms, "cert", `The certificate isn't for ${c.host}`, { detail }));
      done({ ok: true, ms, address: socket.remoteAddress, detail });
    });
    socket.once("error", (err) => {
      const { kind, message } = classify(err);
      done(fail(elapsed(), kind, message));
    });
  });
}
