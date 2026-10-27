/* Noticing that an app runs on Supabase (`docs/flows.md § Suggested checks`): the page, or a few
   of its own script files, name `https://<ref>.supabase.co` and the project's publishable key,
   which a browser app has to carry to talk to Supabase at all (a Next.js app inlines its
   `NEXT_PUBLIC_SUPABASE_*` values into its JavaScript). The run then offers the two checks that
   need no other credential and answer 2xx (`spec.md § 3.6`): Auth health, sent the publishable
   key in an `apikey` header, and Storage status.

   **Only a publishable key, ever.** A key is taken when it is a new-style `sb_publishable_…` key,
   or a legacy JWT whose payload says `"role": "anon"`, issued by Supabase for this project. A
   secret key (`sb_secret_…`), a `service_role` JWT, or anything else that isn't provably the
   public one is never kept, stored or sent: it is skipped as if the page hadn't had it.

   Pure and browser-safe; the server re-checks what the browser sends back with the same
   functions (`addSuggestedChecks`). The two observations are offered and saved as one
   dedicated Supabase monitor; saving re-verifies both routes with that key. */

/** A project's address: twenty lowercase letters and digits on `supabase.co`. */
const PROJECT = /https:\/\/([a-z0-9]{20})\.supabase\.co(?![a-z0-9.-])/g;
const NEW_KEY = /(?<![A-Za-z0-9_])sb_publishable_[A-Za-z0-9_-]{16,128}(?![A-Za-z0-9_-])/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,600}\.eyJ[A-Za-z0-9_-]{10,1200}\.[A-Za-z0-9_-]{20,200}(?![A-Za-z0-9_-])/g;

export const SUPABASE_REF = /^[a-z0-9]{20}$/;

export type SupabaseService = "auth" | "storage";
export const SUPABASE_PATHS: Record<SupabaseService, string> = { auth: "/auth/v1/health", storage: "/storage/v1/status" };
export const SUPABASE_NAMES: Record<SupabaseService, string> = { auth: "Supabase Auth", storage: "Supabase Storage" };

export const supabaseUrl = (ref: string, service: SupabaseService) => `https://${ref}.supabase.co${SUPABASE_PATHS[service]}`;

/** The project and service an address is one of the two checks for, or null. */
export function supabaseCheckOf(url: string): { ref: string; service: SupabaseService } | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co(\/auth\/v1\/health|\/storage\/v1\/status)$/.exec(url);
  if (!m) return null;
  return { ref: m[1], service: m[2] === SUPABASE_PATHS.auth ? "auth" : "storage" };
}

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    const json = new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")), (c) => c.charCodeAt(0)));
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `key` is provably the public key for project `ref`: an `sb_publishable_` key, which
 *  names no project and is checked by the project answering it, or a legacy JWT whose payload
 *  is Supabase's, for this project, with the anonymous role. */
export function isPublishableKey(key: string, ref: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]{16,128}$/.test(key)) return true;
  if (!/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key) || key.length > 2000) return false;
  const p = jwtPayload(key);
  return !!p && p.iss === "supabase" && p.role === "anon" && p.ref === ref;
}

/** The project a text names, and its publishable key when the text has one: the first project
 *  named, unless a legacy key names another the text also names. Null when no project is named. */
export function findSupabase(texts: readonly string[]): { ref: string; key: string | null } | null {
  const refs: string[] = [];
  const keys: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(PROJECT)) if (!refs.includes(m[1])) refs.push(m[1]);
    for (const m of text.matchAll(NEW_KEY)) if (!keys.includes(m[0])) keys.push(m[0]);
    for (const m of text.matchAll(JWT)) if (!keys.includes(m[0])) keys.push(m[0]);
  }
  if (!refs.length) return null;
  for (const ref of refs) {
    const legacy = keys.find((k) => k.startsWith("eyJ") && isPublishableKey(k, ref));
    if (legacy) return { ref, key: legacy };
  }
  const ref = refs[0];
  return { ref, key: keys.find((k) => k.startsWith("sb_publishable_")) ?? null };
}

/** Whether a text could hold either half, so the run knows whether to look in a script at all. */
export const mentionsSupabase = (text: string) => text.includes(".supabase.co");
