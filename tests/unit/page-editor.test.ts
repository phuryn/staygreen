import { describe, expect, it } from "vitest";
import { moveComponent, pageErrorSections } from "@/lib/page-editor";
import { pageDraftSchema } from "@/lib/page-input";

describe("component moves", () => {
  const components = ["API", "Website", "Database"].map((name, i) => ({ key: `stable-${i}`, name, monitorIds: [`monitor-${i}`], inApp: i !== 1 }));
  it("moves in either direction without mutating the draft or changing component identity", () => {
    const moved = moveComponent(components, "stable-2", -1);
    expect(moved.map(c => c.name)).toEqual(["API", "Database", "Website"]);
    expect(moved[1]).toBe(components[2]);
    expect(components.map(c => c.name)).toEqual(["API", "Website", "Database"]);
    expect(moveComponent(moved, "stable-2", 1)).toEqual(components);
    expect(moveComponent(moved, "stable-2", -1).map(c => c.key)).toEqual(["stable-2", "stable-0", "stable-1"]);
  });
  it("refuses the ends, missing keys and empty lists", () => {
    expect(moveComponent(components, "stable-0", -1)).toBe(components);
    expect(moveComponent(components, "stable-2", 1)).toBe(components);
    expect(moveComponent(components, "removed", 1)).toBe(components);
    expect(moveComponent([], "removed", -1)).toEqual([]);
  });
});

describe("opening sections with validation errors", () => {
  it("covers every schema field, opens all affected sections once and ignores form-level errors", () => {
    expect(pageErrorSections({ name: "Required", homepage: "Bad URL", slug: "Taken", components: "Name required", membersOnly: "Unavailable", form: "Try again" }))
      .toEqual(["branding", "address", "components", "options"]);
    for (const field of Object.keys(pageDraftSchema.shape)) expect(pageErrorSections({ [field]: "Invalid" })).toHaveLength(1);
    expect(pageErrorSections({ form: "Try again" })).toEqual([]);
    expect(pageErrorSections({})).toEqual([]);
  });
});
