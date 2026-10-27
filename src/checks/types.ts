/* What every check returns (`docs/product/spec.md § 2, § 3`). One shape for every type, so the
   state machine (`probe/state.ts`), the rollups and the evidence an incident carries never ask
   which check produced it.

   These modules are shared: the probes run them on a schedule, and the dashboard's test of a
   monitor runs them once from the Next server (`src/lib/monitor-test.ts`), as the scan
   (`spec.md § 10`) will. So they import nothing from Next, Clerk or the database, and every
   network decision (which addresses may be reached, which CA is trusted) is a parameter with
   the production answer as its default. */

export type FailureKind =
  | "project_paused" // NXDOMAIN for a Supabase project: paused or deleted, never a manual pause
  | "stripe" // Account-wide delivery threshold or selected endpoint disabled
  | "dns" // the name didn't resolve
  | "private" // it resolved, or redirected, somewhere private (`AGENTS.md § 2.8`)
  | "connect" // refused, reset or unreachable
  | "timeout"
  | "tls" // the handshake failed
  | "cert" // the handshake finished and the certificate is wrong: none, expired, untrusted or for another name
  | "status" // an HTTP status other than the expected one
  | "keyword"
  | "assertion"
  | "redirects" // more than the limit, or to a scheme Staygreen doesn't follow
  | "mismatch" // a DNS record that isn't what the builder said it should be
  | "protocol" // an answer that isn't what the protocol promises
  // A heartbeat's, judged by its home probe from what the receiver recorded (`probe/heartbeat.ts`):
  | "missed" // no finish by the expected run plus the grace window
  | "fail" // the job called its `/fail` URL
  | "stuck"; // a `/start` with no finish within the max run time

export type AssertionResult = {
  path: string;
  op: string;
  expected: string;
  /** What the path held, as JSON, cut to 100 characters; absent when the path was missing. */
  got?: string;
  pass: boolean;
};

export type Timings = { dnsMs?: number; connectMs?: number; tlsMs?: number; ttfbMs?: number };

export type CheckResult = {
  ok: boolean;
  /** Passed, but slower than the monitor's threshold: three in a row is `degraded`. */
  slow?: boolean;
  /** Wall time of the whole check, redirects included. */
  ms: number;
  timings?: Timings;
  status?: number;
  failure?: { kind: FailureKind; message: string };
  assertions?: AssertionResult[];
  /** The first 300 bytes of the body after masking (`mask.ts`), only when the check failed. */
  snippet?: string;
  /** The address the last connection went to, so evidence can say which one failed. */
  address?: string;
  /** Type-specific facts: a certificate's days left, the DNS answers each resolver gave. */
  detail?: Record<string, unknown>;
};

/** Which addresses a check may connect to. Production passes `isPublicIp`; only a test or the
 *  benchmark, which run against their own machine, pass anything else. */
export type AddressGuard = (address: string) => boolean;

export const USER_AGENT = "StaygreenBot/1.0 (+https://staygreen.io/bot)";

export const fail = (ms: number, kind: FailureKind, message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  ok: false,
  ms,
  failure: { kind, message },
  ...extra,
});
