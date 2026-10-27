import { describe, expect, it } from "vitest";
import { built, launch, type LaunchArea } from "@/lib/launch";

// The go-live check, `npm run golive:check` (`docs/RELEASE.md § Go live`), before production's
// billing plan exists. The landing page, /pricing and the terms describe every area the launch list
// calls "live" as part of what a buyer gets (reviews 91 and 93), and `built` says what the code does
// today. Development may sell ahead of the code, because nobody there pays with a real card;
// production may not. Its own vitest project, so the ordinary gate never runs it.
describe("go-live: everything the site sells is built", () => {
  it("has no area marked live that isn't built", () => {
    const ahead = (Object.keys(launch) as LaunchArea[]).filter((a) => launch[a] === "live" && !built[a]);
    expect(
      ahead,
      "live on the site but not built: build them before go-live. Moving one to soon instead is a product decision, and every page that sells it must then say Coming soon too (PlanTable, the landing page and its hero, the comparison, the terms, and the Clerk labels in scripts/clerk/billing.json, which tests/unit/clerk-billing-config.test.ts checks)",
    ).toEqual([]);
  });
});
