/* A heartbeat's token (`AGENTS.md § 2.8`, review 38): 20 random bytes and a 12-byte tag, the
   first 12 bytes of their HMAC-SHA256 under `HEARTBEAT_TOKEN_KEY`, written base64url. That is
   32 bytes, 43 characters: the length every ping URL has always had.

   The tag is what lets the receiver (`ingest/`) refuse a token Staygreen never made without a
   database call, so a flood of made-up URLs costs the database nothing. A token with a good tag
   is then looked up by its SHA-256 (`monitors.heartbeat_token_hash`), as before: the tag says
   Staygreen made it, the lookup says it is still some heartbeat's. Forging a tag without the key
   is a 2^-96 guess.

   Web Crypto only, and nothing from the dashboard, so the Worker, the dashboard and the reissue
   script (`scripts/reissue-heartbeat-tokens.ts`) run this same file. */

/** Every token's length in characters. */
export const TOKEN_LENGTH = 43;
const RANDOM_BYTES = 20;
const TAG_BYTES = 12;
/** Bound into every tag, so this key's MACs mean nothing anywhere else. */
const LABEL = new TextEncoder().encode("staygreen heartbeat token v1\0");

const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The seal's additional data for a heartbeat's sealed URL, so a copy moved to another monitor
    fails to open (`heartbeat.ts`). */
export const heartbeatContext = (monitorId: string) => `monitor:${monitorId}/heartbeat_url`;

function encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** True for 32 bytes written base64url: the key's only accepted shape (the env schema's too). */
export function isTokenKey(raw: string | undefined): raw is string {
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return false;
  return decode(raw).length === 32;
}

let cached: { raw: string; key: Promise<CryptoKey> } | null = null;

function keyOf(raw: string): Promise<CryptoKey> {
  if (!isTokenKey(raw)) throw new Error("HEARTBEAT_TOKEN_KEY must be 32 bytes, base64url");
  if (cached?.raw !== raw) {
    cached = { raw, key: crypto.subtle.importKey("raw", decode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) };
  }
  return cached.key;
}

async function tagOf(raw: string, random: Uint8Array): Promise<Uint8Array> {
  const data = new Uint8Array(LABEL.length + random.length);
  data.set(LABEL);
  data.set(random, LABEL.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", await keyOf(raw), data)).subarray(0, TAG_BYTES);
}

/** A new token under `raw`, the key. */
export async function mintToken(raw: string): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const token = new Uint8Array(RANDOM_BYTES + TAG_BYTES);
  token.set(random);
  token.set(await tagOf(raw, random), RANDOM_BYTES);
  return encode(token);
}

/** Whether `token` was made under `raw`. Constant time in the tag; a token of the wrong shape, or
    written in any but its one canonical spelling, is false. Throws when the key isn't one. */
export async function verifyToken(raw: string, token: string): Promise<boolean> {
  if (!SHAPE.test(token)) return false;
  const bytes = decode(token);
  if (bytes.length !== RANDOM_BYTES + TAG_BYTES || encode(bytes) !== token) return false;
  const expected = await tagOf(raw, bytes.subarray(0, RANDOM_BYTES));
  let diff = 0;
  for (let i = 0; i < TAG_BYTES; i++) diff |= expected[i] ^ bytes[RANDOM_BYTES + i];
  return diff === 0;
}

/** The token's SHA-256, hex: the receiver's lookup key. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
