// Sentences the public site builds from the plan module and the launch list, so a number or a
// place on a page is never typed twice (`src/lib/plans.ts`, `src/lib/launch.ts`).

import { areaLabel, soonAreas } from "@/lib/launch";
import { limits, locationIds, locations, type LocationId, type PlanId } from "@/lib/plans";

/** "a", "a and b", "a, b and c" (or "a, b or c"). */
export function list(items: readonly string[], word: "and" | "or" = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

export const cities = (ids: readonly LocationId[]) => ids.map((id) => locations[id].city);

/** "Frankfurt (Germany)": a city with its country, for copy read by someone who may not know it. */
export const places = (ids: readonly LocationId[]) => ids.map((id) => `${locations[id].city} (${locations[id].country})`);

/** Free's two locations, for the examples that say where a check failed and who confirmed it. */
export const [firstCity, secondCity] = cities(limits.free.locations);

/** The locations Builder adds to Free's. */
export const builderOnlyLocations = limits.builder.locations.filter((id) => !limits.free.locations.includes(id));

/** "every minute", "every 3 minutes". */
export const every = (minutes: number) => (minutes === 1 ? "every minute" : `every ${minutes} minutes`);

export const planName: Record<PlanId, string> = { free: "Free", builder: "Builder" };

/** Where a probe checks monitors today (`locations[id].live`). Every sentence that says where checks
    come from names these, the site's footer and the legal pages included; a plan's own locations
    are its promise, shown on the plans themselves (`PlanTable`). */
export const locationsNow = (): LocationId[] => locationIds.filter((id) => locations[id].live);

/** "Toronto (Canada) and San Francisco (US)": the live locations, a Builder-only one marked so. */
export function checkedFromNow(): string {
  const live = locationsNow();
  const base = list(places(live.filter((id) => limits.free.locations.includes(id))));
  const extra = live.filter((id) => !limits.free.locations.includes(id));
  return extra.length ? `${base}, and from ${list(places(extra))} on Builder` : base;
}

/** "Europe": the continent of the location Builder adds, which is how that location is sold. Every
    location is on one provider, so it is never sold as a second one (`decisions.md`, 2026-10-22). */
export const builderRegion = list([...new Set(builderOnlyLocations.map((id) => locations[id].continent))]);

/** "Monitoring your own MCP server and CSV export": what says Coming soon at launch. */
export const soonList = () => list(soonAreas.map((a) => areaLabel[a]));
