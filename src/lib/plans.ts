// The plan module: Clerk Billing feature slugs to numbers (spec.md § 1, AGENTS.md § 2.6).
//
// Pure and free of Clerk: `entitlementsFrom` is a function of a feature test, so the unit
// suite holds the whole table without a key, and `session.ts` feeds it `has({ feature })`.
// It fails toward Free: a missing, misspelled or erroring feature can only lower a limit.
// The numbers live here once, because two places must agree on them: the screen that says
// what a builder may do, and the SQL function that refuses when they exceed it.

export type PlanId = "free" | "builder";

export const builderSlugs = [
  "scale_builder",
  "white_label",
  "private_pages",
  "subscribers",
  "alert_rules",
  "history_1y",
  "notify_teammates",
] as const;

export type Slug = (typeof builderSlugs)[number];

export type Limits = {
  /** One status page per app is the model, so Builder's apps match its pages (`decisions.md`, 2026-10-22). */
  apps: number;
  monitors: number;
  httpIntervalMin: number;
  mcpIntervalMin: number;
  stripePollMin: number;
  stripeAccounts: number;
  locations: LocationId[];
  assertions: number;
  heartbeats: number;
  heartbeatAssertions: number;
  mcpMonitors: number | "cap";
  supabaseMonitors: number | "cap";
  statusPages: number;
  historyLabel: string;
  apiPerMin: number;
  perHost: number | "fair use";
};

/** DigitalOcean's region slugs: a location's id is the region its probe's droplet runs in. */
export type LocationId = "tor1" | "sfo3" | "fra1";

export type Continent = "North America" | "Europe";

/** A country's flag in `public/flags/` (flag-icons, MIT): its ISO 3166 code. */
export type Flag = "ca" | "us" | "de";

/** Every location a check can run from: the one place their names, countries, flags, continents
    and provider live (`spec.md § 4`). All three are on one provider, so Builder's third is sold as
    Europe, never as a second provider (`decisions.md`, 2026-10-22). Screens name a location by its
    city and country, never its provider. The probe reads the continent too: a Builder monitor's
    failure is re-checked from the other continent first.

    `live` is whether a probe there checks monitors today, which is what the legal pages and `/bot`
    name (`locationsNow()`). Frankfurt's is since 2026-10-24, when a Builder-only probe started
    there in each environment. A Builder-only probe takes only Builder monitors
    (`probe/schedule.ts`, `eligible`), which the store knows by the plan the workspace's members last
    showed (`probe_builder_workspaces`, migration 20261024090000); `tests/unit/legal-pages.test.ts`
    refuses a live Builder-only location while the store reads no plan. */
export const locations: Record<LocationId, { city: string; country: string; flag: Flag; continent: Continent; provider: string; live: boolean }> = {
  tor1: { city: "Toronto", country: "Canada", flag: "ca", continent: "North America", provider: "DigitalOcean", live: true },
  sfo3: { city: "San Francisco", country: "US", flag: "us", continent: "North America", provider: "DigitalOcean", live: true },
  fra1: { city: "Frankfurt", country: "Germany", flag: "de", continent: "Europe", provider: "DigitalOcean", live: true },
};

export const locationIds = Object.keys(locations) as LocationId[];

export const isLocationId = (v: unknown): v is LocationId => typeof v === "string" && Object.hasOwn(locations, v);

export const limits: Record<PlanId, Limits> = {
  free: {
    apps: 1,
    monitors: 50,
    httpIntervalMin: 3,
    mcpIntervalMin: 10,
    stripePollMin: 10,
    stripeAccounts: 1,
    locations: ["tor1", "sfo3"],
    assertions: 3,
    heartbeats: 5,
    heartbeatAssertions: 1,
    mcpMonitors: 2,
    supabaseMonitors: 1,
    statusPages: 1,
    historyLabel: "30 days",
    apiPerMin: 30,
    perHost: 5,
  },
  builder: {
    apps: 10,
    monitors: 100,
    httpIntervalMin: 1,
    mcpIntervalMin: 5,
    stripePollMin: 5,
    stripeAccounts: 3,
    locations: ["tor1", "sfo3", "fra1"],
    assertions: 10,
    heartbeats: 50,
    heartbeatAssertions: 5,
    mcpMonitors: "cap",
    supabaseMonitors: "cap",
    statusPages: 10,
    historyLabel: "1 year",
    apiPerMin: 120,
    perHost: "fair use",
  },
};

/** The owner's own plan for demo status pages of well-known apps (2026-10-25): Builder cloned in
 *  production's Clerk, kept off the pricing table, with this one feature added. It raises the counts
 *  alone; the plan read and stored stays `builder`, so probes and screens treat the workspace as
 *  Builder. Clerk's development instance has no such plan (`tests/integration/clerk-plans.test.ts`). */
export const demoSlug = "scale_demo";
export const demoLimits: Limits = { ...limits.builder, apps: 100, monitors: 1000, heartbeats: 500, statusPages: 100 };

/** The numbers a workspace's screens enforce: the session's own when the snapshot carries them, since a
 *  private plan can raise them above its column, else the plan's column. */
export const limitsOf = (s: { plan: PlanId; limits?: Limits }): Limits => s.limits ?? limits[s.plan];

export const has = (plan: PlanId, slug: Slug) => plan === "builder" && builderSlugs.includes(slug);

/** What a workspace's plan allows, as the session reports it. */
export type Entitlements = {
  /** Which column of the table the limits come from. Cosmetic beyond that. */
  plan: PlanId;
  /** The Builder features held, each independently. */
  features: readonly Slug[];
  limits: Limits;
  /** Clerk didn't answer for `scale_builder`, so the plan is Free only by failing closed: the
   *  request gets Free, and nothing stores it as the workspace's plan (`workspace.ts`). */
  unread?: true;
};

export const FREE: Entitlements = { plan: "free", features: [], limits: limits.free };
/** Free because the session couldn't be read at all, not because it holds nothing. */
export const UNREAD: Entitlements = { ...FREE, unread: true };

export type HasFeature = (slug: string) => boolean;

/** The numbers follow `scale_builder`; every other feature is its own switch, so a
 *  plan can grant one without the others and the caller gets exactly what it holds. */
export function entitlementsFrom(hasFeature: HasFeature): Entitlements {
  let unread = false;
  const held = builderSlugs.filter((slug) => {
    try {
      return hasFeature(slug) === true;
    } catch {
      // Only `scale_builder` decides the plan; another feature's failed read costs that feature.
      if (slug === "scale_builder") unread = true;
      return false;
    }
  });
  const plan: PlanId = held.includes("scale_builder") ? "builder" : "free";
  // Read only on Builder, and a failed read costs only the higher counts.
  const demo = plan === "builder" && (() => { try { return hasFeature(demoSlug) === true; } catch { return false; } })();
  return { plan, features: held, limits: demo ? demoLimits : limits[plan], ...(unread ? { unread: true as const } : {}) };
}

export const holds = (e: Pick<Entitlements, "features">, slug: Slug) => e.features.includes(slug);

export const slugLabel: Record<Slug, string> = {
  scale_builder: "Higher limits and 1-minute checks",
  white_label: "Remove the Staygreen mark",
  private_pages: "Members-only pages",
  subscribers: "Email subscribers",
  alert_rules: "Alert rules and maintenance windows",
  history_1y: "One year of history",
  notify_teammates: "Notify-only teammates",
};
