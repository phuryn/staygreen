import { config } from "dotenv";

/* Rows for the browser suites' fixtures and resets, through PostgREST with the development
   project's secret key. Plain `fetch` rather than supabase-js: the runner may be Node 20, where
   supabase-js wants a WebSocket flag (`docs/integrations.md § Supabase`), and a fixture needs
   nothing realtime. It refuses any project but the development one (`docs/environments.md`). */

config({ quiet: true });

const DEV_REF = "xxxxxxxxxxxxxxxxxxxx";

function target() {
  const url = process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env for the browser suites' fixtures");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== DEV_REF) throw new Error(`refusing ${new URL(url).hostname}: browser fixtures write only to the development project ${DEV_REF}`);
  return { base: `${url.replace(/\/$/, "")}/rest/v1`, key };
}

async function call<T>(method: string, path: string, body?: unknown, prefer = "return=representation"): Promise<T> {
  const { base, key } = target();
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Insert rows and return them. */
export async function insert<T extends Record<string, unknown>>(table: string, rows: Record<string, unknown> | Record<string, unknown>[]): Promise<T[]> {
  return call<T[]>("POST", table, rows);
}

export async function select<T>(table: string, query: string): Promise<T[]> {
  return call<T[]>("GET", `${table}?${query}`);
}

export async function update(table: string, query: string, patch: Record<string, unknown>): Promise<void> {
  await call("PATCH", `${table}?${query}`, patch, "return=minimal");
}

/** Delete every workspace keyed to these Clerk organizations; everything they own cascades. */
export async function deleteWorkspaces(orgIds: string[]): Promise<void> {
  if (!orgIds.length) return;
  for (const id of orgIds) if (!/^org_[A-Za-z0-9]+$/.test(id)) throw new Error(`not an organization id: ${id}`);
  await call("DELETE", `workspaces?clerk_org_id=in.(${orgIds.join(",")})`, undefined, "return=minimal");
}

export async function remove(table: string, query: string): Promise<void> {
  if (!query.includes("=")) throw new Error("refusing a delete with no filter");
  await call("DELETE", `${table}?${query}`, undefined, "return=minimal");
}
