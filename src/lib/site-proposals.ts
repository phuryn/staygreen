import type { Assertion } from "@/checks/assertions";
import type { AccentCandidate } from "./brand";
import { acceptAssertion, bodyForModel } from "./health-body";

/* Between what the page offered and what the model answered (`site-model.ts`): the question as
   the model sees it, and its answer applied, which is where "the model never decides alone" is
   kept. Pure.

   - The accent the model picks must be one of the ids it was shown, each a candidate the page
     itself offered and `brand.ts` already accepted; anything else leaves the page's own first
     candidate in place.
   - Each assertion it proposes must name a route it was shown and pass `acceptAssertion` against
     that route's body, the same gate the deterministic assertion passed. It comes after the
     deterministic one, never twice, and a route carries at most `max`.
   - With no answer, the result is the deterministic one, unchanged. */

/** Fixed ids, so the answer's schema is the same on every call and the API compiles it once
 *  (`site-model.ts`). An id the call wasn't shown is refused when the answer is applied. */
export const ACCENT_IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"] as const;
export const ROUTE_IDS = ["r1", "r2"] as const;
/** The operators the model may propose; `acceptAssertion` narrows what each may compare. */
export const MODEL_OPS = ["==", "!=", "<", "<=", "exists"] as const;

/** What the model is shown. */
export type SiteModelInput = {
  /** The app's host, as the builder typed it. */
  site: string;
  accents: { id: (typeof ACCENT_IDS)[number]; hex: string; from: string[] }[];
  health: { id: (typeof ROUTE_IDS)[number]; path: string; body: string }[];
};

/** What it answers, once its shape is checked. */
export type SiteModelAnswer = {
  accent: (typeof ACCENT_IDS)[number] | null;
  assertions: { route: (typeof ROUTE_IDS)[number]; path: string; op: (typeof MODEL_OPS)[number]; value: string }[];
};

export type HealthBody = { url: string; path: string; json: unknown };

export type Proposals = {
  accent: string | null;
  /** By route address: the assertions its suggestion carries. */
  assertions: Map<string, Assertion[]>;
};

/** Routes whose body the model reads: the first two with a JSON body. */
export const MODEL_ROUTES = ROUTE_IDS.length;

export function modelQuestion(site: string, accents: readonly AccentCandidate[], bodies: readonly HealthBody[]): SiteModelInput {
  return {
    site,
    accents: accents.slice(0, ACCENT_IDS.length).map((c, i) => ({ id: ACCENT_IDS[i], hex: c.hex, from: c.detail })),
    health: bodies.slice(0, MODEL_ROUTES).map((b, i) => ({ id: ROUTE_IDS[i], path: b.path, body: bodyForModel(b.json) })),
  };
}

/** Whether the model has anything to add: a choice between colours, or a body to read. */
export const worthAsking = (q: SiteModelInput) => q.accents.length > 1 || q.health.length > 0;

const keyOf = (a: Assertion) => `${a.path} ${a.op} ${a.value}`;

export function applyAnswer(
  deterministic: Proposals,
  question: SiteModelInput,
  bodies: readonly HealthBody[],
  answer: SiteModelAnswer | null,
  max: number,
): Proposals {
  const assertions = new Map([...deterministic.assertions].map(([url, list]) => [url, list.slice(0, max)]));
  if (!answer) return { accent: deterministic.accent, assertions };

  const picked = question.accents.find((c) => c.id === answer.accent);
  const accent = picked ? picked.hex : deterministic.accent;

  for (const proposal of answer.assertions) {
    const at = question.health.findIndex((h) => h.id === proposal.route);
    const body = at >= 0 ? bodies[at] : undefined;
    if (!body) continue;
    const accepted = acceptAssertion(body.json, proposal);
    if (!accepted) continue;
    const list = assertions.get(body.url) ?? [];
    if (list.length >= max || list.some((a) => keyOf(a) === keyOf(accepted) || a.path === accepted.path)) continue;
    assertions.set(body.url, [...list, accepted]);
  }
  return { accent, assertions };
}
