import tls, { type SecureContext } from "node:tls";

/* One TLS context per trust store, shared by every check. A check still opens its own connection
   and makes a full handshake: no session is ever handed back in, and Node turns off OpenSSL's
   internal session cache, so nothing resumes. What a check no longer does is build a context of
   its own, which under OpenSSL 3 cost about 3 ms of CPU a check, twice the handshake
   (`decisions.md`, the probe benchmark). */

const contexts = new Map<string, SecureContext>();

export function trustContext(ca?: string | Buffer): SecureContext {
  const key = ca === undefined ? "" : ca.toString();
  let c = contexts.get(key);
  if (!c) contexts.set(key, (c = tls.createSecureContext(ca === undefined ? {} : { ca })));
  return c;
}
