import { headline, type PublicView } from "./public-page";
import { accentShades } from "./accents";

export const publicState = (state: string) => state === "up" ? "operational" : state;

/** Derived only from the public DTO. An incident must affect an in-app component to become a banner. */
export function summaryFor(view: PublicView) {
  const head = headline(view);
  const affected = view.components.filter(c => c.inApp && (c.state === "down" || c.state === "degraded"));
  const incident = view.incidents.filter(i => !i.resolvedAt && i.notes.length &&
    i.componentKeys?.some(key => affected.some(c => c.key === key)))
    .sort((a, b) => b.notes[0].at - a.notes[0].at)[0];
  // A mixed checked/unchecked page has not earned "operational".
  const state = head.state === "up" && head.title !== "All systems operational" ? "unchecked" : head.state;
  return {
    page: view.page.slug, status: publicState(state), headline: head.title, updated_at: new Date(view.now).toISOString(),
    components: view.components.map(c => ({ id: c.key, name: c.name, status: publicState(c.state), in_app: c.inApp })),
    incident: incident ? { id: incident.id, title: incident.title, state: incident.notes[0].state,
      note: incident.notes[0].text, update_id: incident.notes[0].id } : null,
    branding: { accent: view.page.accent, mark: view.page.poweredBy,
      link_light: accentShades(view.page.accent, "light").text, link_dark: accentShades(view.page.accent, "dark").text },
  };
}
