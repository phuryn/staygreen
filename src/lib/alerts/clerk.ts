import { hasPermission } from "../authz";

/* A workspace's members, as alert email needs them, read from Clerk's Backend API with plain
   `fetch` at the moment they are needed (`spec.md § 5`: their addresses come from Clerk at send
   time and are never copied into our database). The same reader serves the sender, which runs
   outside Next too, and the Alerts screen.

   Only members whose role can read monitors are reached: an alert carries a monitor's evidence,
   which a member holding nothing in the workspace may not see (`authz.ts`). Each one's address is
   their primary email, only once Clerk has verified it; and their time zone, when Clerk has one,
   is the one their alerts are written in. Pure: the secret key is passed in. */

export const CLERK_API = "https://api.clerk.com/v1";

export type MemberContact = {
  userId: string;
  name: string;
  /** Null when the primary address isn't verified, or there is none. */
  email: string | null;
  timezone: string | null;
};

type Membership = { role?: unknown; public_user_data?: { user_id?: unknown } };
type ClerkUser = {
  id?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  timezone?: unknown;
  banned?: unknown;
  primary_email_address_id?: unknown;
  email_addresses?: { id?: unknown; email_address?: unknown; verification?: { status?: unknown } | null }[];
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const PAGE = 100;

/** The members who may read monitors, or null when Clerk couldn't be read (the caller retries).
 *  An organization Clerk no longer has has no members: `[]`. */
export async function membersOf(secretKey: string, orgId: string, doFetch: typeof fetch = fetch): Promise<MemberContact[] | null> {
  const get = (path: string) =>
    doFetch(`${CLERK_API}${path}`, { headers: { Authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(10_000) });
  try {
    const ids: string[] = [];
    for (let offset = 0; offset < 1_000; offset += PAGE) {
      const r = await get(`/organizations/${encodeURIComponent(orgId)}/memberships?limit=${PAGE}&offset=${offset}`);
      if (r.status === 404) return [];
      if (!r.ok) return null;
      const body = (await r.json()) as { data?: Membership[]; total_count?: unknown };
      const page = Array.isArray(body.data) ? body.data : [];
      for (const m of page) {
        const userId = str(m.public_user_data?.user_id);
        const role = str(m.role);
        if (userId && hasPermission({ id: "", clerk_org_id: orgId }, { userId, orgId, orgRole: role }, "monitors:read")) ids.push(userId);
      }
      if (page.length < PAGE || (typeof body.total_count === "number" && offset + PAGE >= body.total_count)) break;
    }
    if (!ids.length) return [];
    const out: MemberContact[] = [];
    for (let i = 0; i < ids.length; i += PAGE) {
      const q = ids.slice(i, i + PAGE).map((id) => `user_id=${encodeURIComponent(id)}`).join("&");
      const r = await get(`/users?${q}&limit=${PAGE}`);
      if (!r.ok) return null;
      const users = (await r.json()) as ClerkUser[];
      if (!Array.isArray(users)) return null;
      for (const u of users) {
        const userId = str(u.id);
        if (!userId || u.banned === true) continue;
        const primary = (u.email_addresses ?? []).find((a) => a.id === u.primary_email_address_id);
        const email = primary && primary.verification?.status === "verified" ? str(primary.email_address) : null;
        const name = [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ") || str(u.username) || email || "A member";
        out.push({ userId, name, email, timezone: str(u.timezone) });
      }
    }
    return out;
  } catch {
    return null;
  }
}
