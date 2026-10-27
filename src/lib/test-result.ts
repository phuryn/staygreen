/* What testing a monitor before saving it hands the browser (`src/lib/monitor-test.ts` makes it,
   `src/components/TestResult.tsx` shows it), and the one thing the screen does with it besides
   reading: turn a value of a JSON body into an assertion for its path.

   Pure and shared: the server builds these shapes, the form reads them, and nothing here imports
   Node. Every string in a result has already passed through the masker on the server. */

import type { AssertionResult, FailureKind } from "@/checks/types";
import type { Op } from "./model";

/** A JSON body, value by value, masked. Object entries are pairs rather than an object, so a key
 *  like `__proto__` is only ever a string, and every container says how many of its children it
 *  left out (`more`) once the tree reached its size. */
export type JsonNode =
  | { t: "object"; entries: JsonEntry[]; more: number }
  | { t: "array"; items: JsonNode[]; more: number }
  | { t: "string"; v: string; masked?: true; cut?: true }
  | { t: "number"; v: number }
  | { t: "boolean"; v: boolean }
  | { t: "null" };

/** `masked`: the key itself looked like a secret and is shown masked, so no path can name it. */
export type JsonEntry = { k: string; masked?: true; n: JsonNode };

export type HttpTest = {
  url: string;
  method: string;
  expect: string;
  slowMs: number;
  /** Absent when no response arrived. */
  status?: number;
  /** Whether the status is the expected one (`statusMatches` in `src/checks/http.ts`). */
  statusOk?: boolean;
  address?: string;
  redirects: { status: number; location: string }[];
  headers: [string, string][];
  body?: {
    bytes: number;
    /** The check read 64 KB and stopped. */
    truncated: boolean;
    contentType: string | null;
    kind: "empty" | "text" | "json" | "binary";
    /** The masked text, for `text` and `json`. */
    text?: string;
    json?: JsonNode;
  };
  keyword?: { text: string; found: boolean };
  assertions: AssertionResult[];
};

export type TcpTest = { host: string; port: number; tls: boolean; address?: string };

export type SslTest = {
  host: string;
  address?: string;
  issuer?: string | null;
  subject?: string | null;
  /** The names the certificate covers, from its subject alternative names. */
  names: string[];
  expiresAt?: string;
  daysLeft?: number;
  /** Null when the certificate couldn't be read, or the host is an IP address. */
  nameMatches: boolean | null;
  trusted: boolean | null;
};

export type DnsTest = {
  record: string;
  name: string;
  expected: string;
  resolvers: { id: string; label: string; answers?: string[]; error?: string; matches: boolean }[];
};

export type TestOutcome = {
  /** The check's own verdict, the one the probes would reach from where they are. */
  ok: boolean;
  slow?: boolean;
  ms: number;
  failure?: { kind: FailureKind; message: string };
  /** When it ran, as the server's clock had it (ms since the epoch). */
  at: number;
  /** The longest the check was allowed, in seconds. */
  timeoutSec: number;
} & ({ type: "http"; http: HttpTest } | { type: "tcp"; tcp: TcpTest } | { type: "ssl"; ssl: SslTest } | { type: "dns"; dns: DnsTest }
  | { type: "stripe" | "supabase"; service: { saveable: boolean; summary: string; steps: { name: string; ok: boolean; status?: number }[] } });

/** A key `parsePath` reads after a dot (`src/checks/assertions.ts`); anything else is bracketed. */
const IDENT = /^[A-Za-z_$][\w$-]*$/;

/** The JSONPath the checks read for a value, from the keys and indexes that lead to it. */
export function pathOf(steps: readonly (string | number)[]): string {
  return `$${steps.map((s) => (typeof s === "number" ? `[${s}]` : IDENT.test(s) ? `.${s}` : `["${s.replace(/["\\]/g, "\\$&")}"]`)).join("")}`;
}

/** The longest path and value an assertion may hold (`assertion` in `src/lib/monitor-input.ts`). */
export const PATH_MAX = 200;
export const VALUE_MAX = 500;

/** The assertion a click on `node` adds: equal to the value it holds, written the way the
 *  checks read it back (`typed` in `src/checks/assertions.ts`), so it passes against the body it
 *  came from. A string that would read as JSON (`"12"`, `"true"`) is quoted, so it stays a
 *  string. A value the screen can't show whole (masked, or cut for length) and a container ask
 *  only that the path exists, since equal-to-what-you-see would be false. */
export function assertionFor(node: JsonNode): { op: Op; value: string } {
  const exists = { op: "exists" as const, value: "" };
  switch (node.t) {
    case "string": {
      if (node.masked || node.cut) return exists;
      let value = node.v;
      try {
        JSON.parse(node.v);
        value = JSON.stringify(node.v);
      } catch {
        // Not JSON, so the checks read it as the string it is.
      }
      return value.length > VALUE_MAX ? exists : { op: "==", value };
    }
    case "number":
    case "boolean":
      return { op: "==", value: String(node.v) };
    case "null":
      return { op: "==", value: "null" };
    default:
      return exists;
  }
}
