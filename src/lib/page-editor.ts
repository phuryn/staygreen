import type { PageDraft } from "./page-input";

/** Preserve the objects (and their browser keys) while changing only their order. */
export function moveComponent<T extends { key: string }>(components: T[], key: string, direction: -1 | 1): T[] {
  const from = components.findIndex(c => c.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= components.length) return components;
  const moved = [...components];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}

export type PageEditorSection = "branding" | "address" | "components" | "options";
const fieldSection: Record<keyof PageDraft, PageEditorSection> = {
  name: "branding", logoText: "branding", homepage: "branding", accent: "branding", theme: "branding",
  slug: "address", components: "components",
  demo: "options", poweredBy: "options", noindex: "options", membersOnly: "options", historyDays: "options",
};

/** Both browser validation and server refusals name the draft's top-level fields. */
export function pageErrorSections(errors: Record<string, string>): PageEditorSection[] {
  return [...new Set(Object.keys(errors).flatMap(field => {
    const section = fieldSection[field as keyof PageDraft];
    return section ? [section] : [];
  }))];
}
