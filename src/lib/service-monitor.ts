/** Public configuration only. Credentials never belong in config or a screen's snapshot. */
export const SERVICE_KEY = "service-key";
export const STRIPE_CRITICAL = ["checkout.session.completed", "invoice.paid", "customer.subscription.*"];
/** SQL for a constant one-row view, named as the builder typed the read once that is a table or
 *  view name, else `staygreen_health`. An `rpc/` read names a function the builder already has. */
export const supabaseReadSql = (read: string) => {
  const name = databaseReadName(read.trim()) && !read.trim().startsWith("rpc/") ? read.trim() : "staygreen_health";
  return `create view public.${name} with (security_invoker = true) as select true as ok;
grant select on public.${name} to anon;`;
};
export type SupabaseConfig = { projectUrl: string; databaseRead: string };
export type StripeConfig = { endpoints: string[]; critical: string[]; failureThreshold: number; windowMin: number; pendingMin: number };
export const isService = (type: string): type is "stripe" | "supabase" => type === "stripe" || type === "supabase";
export const restrictedKey = (key: string) => /^rk_(test|live)_[A-Za-z0-9]{16,200}$/.test(key);
export const projectRef = (url: string) => /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url)?.[1] ?? null;
export const databaseReadName = (name: string) => /^(?:rpc\/)?[a-z_][a-z0-9_]{0,62}$/.test(name);
export const dashboardUrl = (url: string) => `https://supabase.com/dashboard/project/${projectRef(url) ?? ""}`;
