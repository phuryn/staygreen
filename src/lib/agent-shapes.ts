import "server-only";
import { BlockList, isIP } from "node:net";
import { mask } from "@/checks/mask";

/** What a client sends /mcp, as names, counts and shapes, never values: which `params._meta` keys
 *  ChatGPT's OAuth connector sends, how it initializes, where it calls from and whether its grant
 *  refreshes were unobserved (owner, 2026-10-27). Temporary: nothing is recorded from SHAPES_UNTIL,
 *  and a later migration drops the column (`BACKLOG.md`). */
export const SHAPES_UNTIL = Date.parse("2026-11-10T00:00:00Z");
export const legalDate = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const OPENAI_RANGES = "https://openai.com/chatgpt-connectors.json";
/** Under the column's 4,096-byte check, with room for `openai_range`. */
export const SHAPE_BYTES = 3800;
export type CallShape = {
  headers?: string[]; user_agent?: string; protocol_header?: string; params?: string[]; meta?: string[];
  init?: { client: string; version: string; requested: string; agreed: string; capabilities: string[] };
  token?: { age_s: number | null; lifetime_s: number | null; scopes: string[]; client_id: "url" | "opaque" };
  openai_range?: boolean | null; trimmed?: true;
};

const NAME = /^[A-Za-z0-9_.:/-]{1,64}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}$/;
const LONG_RUN = /[A-Za-z0-9]{20,}/;
/** A name a caller could have used to carry a value: an address (a trailing dot or a fifth group
 *  included), an id or key (a long run, eight digits in a row, a prefixed id, a segment mixing
 *  eight or more letters and digits, as a UUID's do), an email. A name is something a client was
 *  built with, and never one of these. A caller can still choose a name shaped like none of them
 *  that carries one: that is its own text, not anyone's data, and the rules stop here (review
 *  shapes3, accepted). */
const valueLike = (s: string) => isIP(s.replace(/\.$/, "")) !== 0 || /\d+(?:\.\d+){3}/.test(s) || LONG_RUN.test(s) || /\d{8,}/.test(s)
  || /^(?:user|org|sess|client|oauthapp|sg|sk|rk|pk)_[A-Za-z0-9]{8,}/i.test(s) || s.split(/[^A-Za-z0-9]+/).some(seg => seg.length >= 8 && /\d/.test(seg) && /[A-Za-z]/.test(seg))
  || mask(s) !== s;
const safeName = (k: string) => NAME.test(k) && !valueLike(k) ? k : "?";
/** An object's key names, sorted, at most 30; any other name is "?". */
export function keyNames(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.keys(value).map(safeName).sort().slice(0, 30);
}
/** The product tokens of a user agent (`name/version`), without its comments, which can name a
 *  system, an unclosed one included, and without any token that could be a value. */
export function userAgentProducts(ua: string | null) {
  const products = (ua ?? "").replace(/\([^)]*(?:\)|$)/g, " ").split(/\s+/)
    .filter(t => /^[A-Za-z0-9._+-]{1,40}(\/[A-Za-z0-9._+-]{1,40})?$/.test(t) && !t.split("/").some(valueLike));
  return products.slice(0, 6).join(" ") || undefined;
}
export const protocolName = (v: unknown) => typeof v !== "string" ? "none" : VERSION.test(v) ? v : "other";
const DECLARED = /^[A-Za-z0-9][A-Za-z0-9 ._+/-]*$/;
/** A client's declared name or version, kept only whole and only when it reads as one: plain
 *  characters, within its length, and no word in it value-like. Anything else is "?", so nothing a
 *  caller types there reaches the log, and no cut can bring part of a value in (reviews shapes1-2). */
function declared(v: unknown, max: number) {
  if (typeof v !== "string" || v.length > max || !DECLARED.test(v)) return "?";
  return v.split(/[\s/]+/).some(valueLike) ? "?" : v;
}

export function requestShape(request: Request): CallShape {
  return {
    headers: [...new Set([...request.headers.keys()].map(k => safeName(k.toLowerCase())))].sort().slice(0, 40),
    user_agent: userAgentProducts(request.headers.get("user-agent")),
    protocol_header: protocolName(request.headers.get("mcp-protocol-version") ?? undefined),
  };
}
export function initializeShape(params: { protocolVersion: string; capabilities: object; clientInfo: { name: string; version: string } }, agreed: string): CallShape["init"] {
  return { client: declared(params.clientInfo.name, 80), version: declared(params.clientInfo.version, 40), requested: protocolName(params.protocolVersion), agreed, capabilities: keyNames(params.capabilities) ?? [] };
}
export function tokenShape(grant: { issuedAt?: number; expiresAt?: number; scopes: string[]; clientId: string }, now = Date.now()): CallShape["token"] {
  const seconds = Math.floor(now / 1000);
  return {
    age_s: grant.issuedAt === undefined ? null : seconds - grant.issuedAt,
    lifetime_s: grant.issuedAt === undefined || grant.expiresAt === undefined ? null : grant.expiresAt - grant.issuedAt,
    scopes: grant.scopes.map(safeName).sort().slice(0, 20),
    client_id: /^https:\/\//.test(grant.clientId) ? "url" : "opaque",
  };
}
/** A shape cut to fit the column: every list to its first ten names, else only what names no list. */
export function fitted(shape: CallShape): CallShape {
  const size = (s: CallShape) => Buffer.byteLength(JSON.stringify(s));
  if (size(shape) <= SHAPE_BYTES) return shape;
  const ten = (l?: string[]) => l?.slice(0, 10);
  const cut: CallShape = { ...shape, headers: ten(shape.headers), params: ten(shape.params), meta: ten(shape.meta), trimmed: true,
    ...(shape.init ? { init: { ...shape.init, capabilities: shape.init.capabilities.slice(0, 10) } } : {}),
    ...(shape.token ? { token: { ...shape.token, scopes: shape.token.scopes.slice(0, 10) } } : {}) };
  if (size(cut) <= SHAPE_BYTES) return cut;
  return { user_agent: shape.user_agent, protocol_header: shape.protocol_header, trimmed: true };
}

let ranges: { list: BlockList; at: number } | null = null;
/** Whether the caller's address is one OpenAI publishes for ChatGPT's connectors, so no address is
 *  kept: Netlify sets `x-nf-client-connection-ip` at its edge. Null without an address or the list. */
export async function inOpenAIRanges(request: Request, load: typeof fetch = fetch, now = Date.now()): Promise<boolean | null> {
  const address = request.headers.get("x-nf-client-connection-ip") ?? "";
  const kind = isIP(address);
  if (!kind) return null;
  if (!ranges || now - ranges.at > 6 * 3600_000) {
    try {
      const body = await (await load(OPENAI_RANGES, { signal: AbortSignal.timeout(3000) })).json() as { prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] };
      const list = new BlockList();
      for (const p of body.prefixes ?? []) {
        const [net, bits] = (p.ipv4Prefix ?? p.ipv6Prefix ?? "").split("/");
        try { list.addSubnet(net, Number(bits), p.ipv4Prefix ? "ipv4" : "ipv6"); } catch { /* A malformed entry is skipped. */ }
      }
      ranges = { list, at: now };
    } catch { return null; }
  }
  return ranges.list.check(address, kind === 6 ? "ipv6" : "ipv4");
}
export const resetRanges = () => { ranges = null; };
