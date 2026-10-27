import { isPublishableKey } from "../lib/supabase-detect";
import { databaseReadName, dashboardUrl, projectRef, type SupabaseConfig } from "../lib/service-monitor";
import { jsonObject, serviceFetch, within, type ServiceFetch } from "./service-fetch";
import { fail, type CheckResult } from "./types";

export type ServiceStep = { name: string; ok: boolean; status?: number };

/** Health routes never probe REST's root, a guessed relation, login, or a write RPC.
 * GET RPCs must be STABLE/IMMUTABLE; PostgREST refuses volatile functions on GET. */
export async function checkSupabase(c: SupabaseConfig, key: string, o: {
  fetch?: ServiceFetch; timeoutMs?: number;
} = {}): Promise<CheckResult> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  const ref = projectRef(c.projectUrl);
  if (!ref || !isPublishableKey(key, ref) || (c.databaseRead && !databaseReadName(c.databaseRead)))
    return fail(ms(), "protocol", "Enter the project URL, its publishable key, and a valid database read name.");
  const steps: ServiceStep[] = [];
  const detail = { steps, dashboardUrl: dashboardUrl(c.projectUrl), pauseRisk: !c.databaseRead };
  const fetch = within(o.fetch ?? serviceFetch(), o.timeoutMs);
  const paths = [{ name: "Auth health", path: "/auth/v1/health" }, { name: "Storage status", path: "/storage/v1/status" },
    ...(c.databaseRead ? [{ name: "Database read", path: `/rest/v1/${c.databaseRead}?limit=1` }] : [])];
  for (const { name, path } of paths) {
    const a = await fetch(`https://${ref}.supabase.co${path}`, { apikey: key, accept: "application/json" }, 0);
    if ("error" in a) {
      steps.push({ name, ok: false });
      if (a.code === "ENOTFOUND") return fail(ms(), "project_paused", `Project paused or deleted. Open ${dashboardUrl(c.projectUrl)}`, { detail });
      return fail(ms(), a.error, `${name} could not be read (${a.error}).`, { detail });
    }
    const ok = a.status >= 200 && a.status < 300;
    steps.push({ name, ok, status: a.status });
    if (!ok) return fail(ms(), "status", `${name} answered ${a.status}. Check the key and anonymous read permission.`, {
      status: a.status, detail,
    });
    if (name === "Auth health" && typeof jsonObject(a.body)?.version !== "string") return fail(ms(), "protocol", "Auth health did not answer with GoTrue's version JSON.", { detail });
    if (name === "Database read") {
      try { JSON.parse(a.body); } catch { return fail(ms(), "protocol", "Database read did not answer with JSON.", { detail }); }
    }
  }
  return { ok: true, ms: ms(), detail };
}
