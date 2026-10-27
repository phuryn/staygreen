/* The few Clerk Backend API calls the authenticated suite's setup makes. Development instance
   only: a live secret key is refused before any request. */

const API = "https://api.clerk.com/v1";

function key() {
  const k = process.env.CLERK_SECRET_KEY ?? "";
  if (!k.startsWith("sk_test_")) throw new Error("CLERK_SECRET_KEY must be a development key (sk_test_…); the browser suites never touch a live instance");
  return k;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Clerk ${method} ${path.split("?")[0]} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

type User = { id: string };
type Org = { id: string; name: string };

/** The user with this address, created when the instance lacks it (no password, no legal step). */
export async function findOrCreateUser(email: string): Promise<User> {
  const found = await call<User[]>("GET", `/users?email_address=${encodeURIComponent(email)}`);
  if (found.length) return found[0];
  return call<User>("POST", "/users", { email_address: [email], skip_password_requirement: true, skip_legal_checks: true });
}

/** The user's organization, created with them as its admin when they have none. */
export async function findOrCreateOrg(userId: string, name: string): Promise<Org> {
  const { data } = await call<{ data: { organization: Org }[] }>("GET", `/users/${userId}/organization_memberships?limit=10`);
  const own = data.find((m) => m.organization.name === name) ?? data[0];
  if (own) return own.organization;
  return call<Org>("POST", "/organizations", { name, created_by: userId });
}
