import { describe, expect, it } from "vitest";
import { headline, incidentDto, snapshotDto, viewFromDto, viewFromSim, type PublicView } from "@/lib/public-page";
import type { State } from "@/lib/model";
import { component, DAY, incident, monitor, note, NOW, page, sim } from "./fixtures";

/** Ninety days of no data with `at` filled in: index 89 is today. */
const days90 = (at: Record<number, number>) => Array.from({ length: 90 }, (_, i) => at[i] ?? -1);

/* What a public status page shows, and nothing else (`src/lib/public-page.ts`).
   The DTO is the allowlist: whatever the snapshot function adds beside the
   fields it names never reaches a visitor. Every value that must not leak
   carries the marker below, so one sweep over the output catches any of them. */

const LEAK = "LEAK-7f3a";

const OPENED = "2026-10-21T10:00:00.123456+00:00"; // Postgres' own timestamptz-in-jsonb shape
const NOTED = "2026-10-21T10:05:00+00:00";

/** A snapshot as the function returns it, plus every extra key it might grow. */
function snapshot() {
  return {
    workspaceId: `ws_${LEAK}`,
    monitors: [{ id: `mon_${LEAK}`, target: `https://internal.example.com/${LEAK}` }],
    page: {
      slug: "askone",
      name: "AskOne status",
      logoText: "AskOne",
      homepage: null,
      accent: "#1F2DE6",
      theme: "visitor",
      poweredBy: true,
      noindex: false,
      historyDays: 90,
      id: `page_${LEAK}`,
      workspaceId: `ws_${LEAK}`,
      appId: `app_${LEAK}`,
      password: LEAK,
      customDomainToken: LEAK,
    },
    components: [
      {
        key: 0,
        name: "API",
        inApp: true,
        states: ["up", null],
        // NOW is 21 October, 12:00 UTC: today, two days before it, and a day ahead of the
        // browser's clock, which has no bar yet.
        daily: [{ d: "2026-10-19", up: 100, monitorId: `mon_${LEAK}` }, { d: "2026-10-21", up: 99.5 }, { d: "2026-10-22", up: 50 }],
        monitorIds: [`mon_${LEAK}`],
        monitorUrl: `https://internal.example.com/${LEAK}`,
        workspaceId: `ws_${LEAK}`,
      },
      { key: 1, name: "Database", inApp: false, states: [null, null], daily: [], target: LEAK },
    ],
    incidents: [
      {
        id: "inc_0123456789abcdef01234567",
        title: `API health ${LEAK} is down`,
        severity: "down",
        openedAt: OPENED,
        resolvedAt: null,
        components: [0, 1],
        monitorId: `mon_${LEAK}`,
        target: `https://internal.example.com/${LEAK}`,
        snippet: `{"error":"${LEAK}"}`,
        draftNotes: [{ id: "note_draft", body: `DRAFT ${LEAK}` }],
        draft: `DRAFT ${LEAK}`,
        notes: [{ id: "note_1", state: "identified", body: "The database is unreachable.", at: NOTED, status: "published", author_user_id: `user_${LEAK}`, authorClient: LEAK }],
      },
    ],
  };
}

const view = (raw: unknown = snapshot()) => viewFromDto(snapshotDto.parse(raw), NOW);

describe("the DTO is an allowlist", () => {
  it("maps a snapshot to exactly the PublicView shape", () => {
    expect(view()).toStrictEqual({
      page: { slug: "askone", name: "AskOne status", logoText: "AskOne", logoUrl: null, faviconUrl: null, homepage: "", accent: "#1F2DE6", theme: "visitor", poweredBy: true, noindex: false, historyDays: 90 },
      components: [
        { key: "0", name: "API", inApp: true, state: "up", daily: days90({ 87: 100, 89: 99.5 }) },
        { key: "1", name: "Database", inApp: false, state: "unchecked", daily: days90({}) },
      ],
      incidents: [
        {
          id: "inc_0123456789abcdef01234567",
          title: expect.any(String),
          severity: "down",
          openedAt: Date.parse(OPENED),
          resolvedAt: null,
          componentKeys: ["0", "1"],
          notes: [{ id: "note_1", state: "identified", text: "The database is unreachable.", at: Date.parse(NOTED) }],
        },
      ],
      updatedAt: null,
      now: NOW,
    } satisfies PublicView);
  });

  it("lets no extra key through, at any depth", () => {
    expect(JSON.stringify(view())).not.toContain(LEAK);
  });

  it("drops extra keys already at the parse, so nothing downstream can reach them", () => {
    const parsed = snapshotDto.parse(snapshot());
    expect(Object.keys(parsed).sort()).toEqual(["components", "incidents", "page"]);
    expect(Object.keys(parsed.page).sort()).toEqual(["accent", "faviconUrl", "historyDays", "homepage", "logoText", "logoUrl", "name", "noindex", "poweredBy", "slug", "theme"]);
    expect(Object.keys(parsed.components[0]).sort()).toEqual(["daily", "inApp", "key", "name", "states"]);
    expect(Object.keys(parsed.components[0].daily[0]).sort()).toEqual(["d", "up"]);
    expect(Object.keys(parsed.incidents[0]).sort()).toEqual(["components", "id", "notes", "openedAt", "resolvedAt", "severity", "title"]);
    expect(Object.keys(parsed.incidents[0].notes![0]).sort()).toEqual(["at", "body", "id", "state"]);
  });

  it("does the same for the incident read, keeping only its id beside the snapshot", () => {
    const parsed = incidentDto.parse({ ...snapshot(), incidentId: "inc_0123456789abcdef01234567" });
    expect(parsed.incidentId).toBe("inc_0123456789abcdef01234567");
    expect(JSON.stringify(viewFromDto(parsed, NOW))).not.toContain(LEAK);
  });

  it.each([
    ["an accent that is not a hex colour", (s: ReturnType<typeof snapshot>) => void (s.page.accent = "url(javascript:alert(1))")],
    ["an unknown theme", (s: ReturnType<typeof snapshot>) => void (s.page.theme = "sepia")],
    ["an unknown state", (s: ReturnType<typeof snapshot>) => void (s.components[0].states = ["exploded"])],
    ["an unknown note state", (s: ReturnType<typeof snapshot>) => void (s.incidents[0].notes[0].state = "draft")],
    ["a timestamp that is not one", (s: ReturnType<typeof snapshot>) => void (s.incidents[0].openedAt = "yesterday")],
    ["a missing page", (s: ReturnType<typeof snapshot>) => void delete (s as Partial<ReturnType<typeof snapshot>>).page],
    ["a component with no days", (s: ReturnType<typeof snapshot>) => void delete (s.components[1] as { daily?: unknown }).daily],
    ["a day that is not a date", (s: ReturnType<typeof snapshot>) => void (s.components[0].daily[0].d = "yesterday")],
    ["an uptime above 100", (s: ReturnType<typeof snapshot>) => void (s.components[0].daily[0].up = 100.5)],
  ])("refuses a snapshot with %s rather than showing it half-checked", (_name, spoil) => {
    const s = snapshot();
    spoil(s);
    expect(snapshotDto.safeParse(s).success).toBe(false);
  });

  it("keeps a page's homepage when it has one", () => {
    const s = snapshot();
    s.page.homepage = "https://askone.org" as never;
    expect(view(s).page.homepage).toBe("https://askone.org");
  });
});

describe("viewFromDto states", () => {
  const stateOf = (states: (string | null)[]) => {
    const s = snapshot();
    s.components = [{ key: 0, name: "API", inApp: false, states, daily: [] } as never];
    s.incidents = [];
    return view(s).components[0].state;
  };

  it.each([
    [[null], "unchecked"],
    [[null, null], "unchecked"],
    [[null, "up"], "up"],
    [[null, "down"], "down"],
    [["degraded", "up"], "degraded"],
    [["paused"], "paused"],
    [["paused", null], "unchecked"],
    [[], "unchecked"],
  ] as [(string | null)[], State][])("reads monitor states %j as %s", (states, expected) => {
    expect(stateOf(states)).toBe(expected);
  });
});

describe("incident titles name components, not monitors", () => {
  it("names the components the incident hit", () => {
    const t = view().incidents[0].title;
    expect(t).toContain("API");
    expect(t).toContain("Database");
    expect(t).not.toContain("API health");
  });

  it("names only the components it hit", () => {
    const s = snapshot();
    s.incidents[0].components = [1];
    const t = view(s).incidents[0].title;
    expect(t).toContain("Database");
    expect(t).not.toMatch(/\bAPI\b/);
  });

  it("words down and degraded differently", () => {
    const s = snapshot();
    s.incidents[0].severity = "degraded";
    expect(view(s).incidents[0].title).not.toBe(view().incidents[0].title);
  });

  it("titles an incident the same way the editor's preview does", () => {
    const s = sim({
      monitors: [monitor({ id: "m_api" }), monitor({ id: "m_db" })],
      incidents: [incident({ id: "inc_1", monitorId: "m_api", title: "API health is down", notes: [note({ id: "n1" })] })],
    });
    const p = page({ components: [component({ id: "c1", name: "API", monitorIds: ["m_api"] }), component({ id: "c2", name: "Database", monitorIds: ["m_api", "m_db"] })] });
    expect(viewFromSim(s, p).incidents[0].title).toBe(view().incidents[0].title);
  });

  it("leaves out of the preview an incident on a monitor no component shows, as the public page does", () => {
    const s = sim({
      monitors: [monitor({ id: "m_api" }), monitor({ id: "m_job" })],
      incidents: [incident({ id: "inc_job", monitorId: "m_job", title: "Nightly import is down", notes: [note({ id: "n1" })] })],
    });
    const p = page({ components: [component({ id: "c1", name: "API", monitorIds: ["m_api"] })] });
    expect(viewFromSim(s, p).incidents).toEqual([]);
  });
});

describe("headline", () => {
  const withStates = (...states: State[]): PublicView => ({
    page: view().page,
    components: states.map((state, i) => ({ key: String(i), name: `C${i}`, inApp: false, state, daily: [] })),
    incidents: [],
    updatedAt: null,
    now: NOW,
  });
  const OPERATIONAL = headline(withStates("up", "up")).title;

  it("says all is well when every component is up", () => {
    expect(headline(withStates("up", "up"))).toEqual({ state: "up", title: OPERATIONAL });
  });

  it("never calls a page with no components operational", () => {
    const h = headline(withStates());
    expect(h.state).toBe("unchecked");
    expect(h.title).not.toBe(OPERATIONAL);
    expect(h.detail).toBeTruthy();
  });

  it("never calls a page operational when nothing on it has been checked", () => {
    const h = headline(withStates("unchecked", "unchecked"));
    expect(h.state).toBe("unchecked");
    expect(h.title).not.toBe(OPERATIONAL);
    expect(h.title).not.toBe(headline(withStates()).title);
    expect(h.detail).toBeTruthy();
  });

  it("never calls a page all clear while a component on it is paused or not checked", () => {
    const h = headline(withStates("up", "paused", "unchecked"));
    expect(h.title).not.toBe(OPERATIONAL);
    expect(h.detail).toContain("C1");
    expect(h.detail).toContain("C2");
    expect(h.detail).not.toContain("C0");
  });

  it("names the components that are down, and only those", () => {
    const h = headline(withStates("up", "down", "degraded", "down"));
    expect(h.state).toBe("down");
    expect(h.title).toContain("C1");
    expect(h.title).toContain("C3");
    expect(h.title).not.toContain("C0");
    expect(h.title).not.toContain("C2");
  });

  it("names the degraded components when nothing is down", () => {
    const h = headline(withStates("up", "degraded"));
    expect(h.state).toBe("degraded");
    expect(h.title).toContain("C1");
    expect(h.title).not.toContain("C0");
    expect(h.title).not.toBe(OPERATIONAL);
  });
});

describe("viewFromSim, the editor's preview", () => {
  const s = sim({
    plan: "free",
    monitors: [
      monitor({ id: "m_api", target: `https://internal.example.com/${LEAK}`, reports: [{ loc: "tor1", end: NOW - 30_000, checks: 2, failures: 0, p50: 120 }] }),
      monitor({
        id: "m_db",
        state: "down",
        reports: [
          { loc: "sfo3", end: NOW - 10_000, checks: 2, failures: 2, p50: null },
          { loc: "tor1", end: NOW - 40_000, checks: 2, failures: 1, p50: 300 },
        ],
      }),
      monitor({ id: "m_other", appId: "app_2" }),
    ],
    incidents: [
      incident({
        id: "inc_1",
        monitorId: "m_db",
        title: `Postgres ${LEAK} is down`,
        notes: [note({ id: "n_old", at: NOW - 5000 }), note({ id: "n_draft", status: "draft", text: `DRAFT ${LEAK}`, at: NOW - 1000 }), note({ id: "n_new", state: "identified", at: NOW - 2000 })],
        evidence: { request: `GET https://internal.example.com/${LEAK}`, summary: LEAK, locations: [], snippet: LEAK },
      }),
      // Nothing published yet: not on the page.
      incident({ id: "inc_2", monitorId: "m_api", notes: [note({ id: "n_d2", status: "draft" })] }),
      // Another app's incident: not on this page.
      incident({ id: "inc_3", appId: "app_2", monitorId: "m_other", notes: [note({ id: "n_o" })] }),
      // Resolved before the page's history window.
      incident({ id: "inc_4", monitorId: "m_db", openedAt: NOW - 100 * DAY, resolvedAt: NOW - 95 * DAY, notes: [note({ id: "n_h", at: NOW - 95 * DAY })] }),
    ],
  });
  const p = page({
    poweredBy: false,
    components: [component({ id: "c_api", name: "API", inApp: true, monitorIds: ["m_api"] }), component({ id: "c_db", name: "Database", monitorIds: ["m_db"] }), component({ id: "c_empty", name: "Empty", monitorIds: [] })],
  });
  const v = viewFromSim(s, p);

  it("has exactly the PublicView keys", () => {
    expect(Object.keys(v).sort()).toEqual(["components", "incidents", "now", "page", "updatedAt"]);
    expect(Object.keys(v.page).sort()).toEqual(Object.keys(view().page).sort());
  });

  it("shows only components something checks", () => {
    expect(v.components.map((c) => [c.key, c.name, c.state])).toEqual([
      ["c_api", "API", "up"],
      ["c_db", "Database", "down"],
    ]);
  });

  it("shows only this app's incidents with a published update, inside the history window", () => {
    expect(v.incidents.map((i) => i.id)).toEqual(["inc_1"]);
  });

  it("shows published notes only, newest first, and never a draft", () => {
    expect(v.incidents[0].notes.map((n) => n.id)).toEqual(["n_new", "n_old"]);
  });

  it("names the incident after its component and leaks no monitor detail", () => {
    expect(v.incidents[0].title).toContain("Database");
    expect(JSON.stringify(v)).not.toContain(LEAK);
  });

  it("keeps the Staygreen mark on a Free page even when the builder turned it off", () => {
    expect(v.page.poweredBy).toBe(true);
    expect(viewFromSim({ ...s, plan: "builder" }, p).page.poweredBy).toBe(false);
  });

  it("dates the page from its newest report, and claims none before the first", () => {
    expect(v.updatedAt).toBe(NOW - 10_000);
    const unchecked = sim({ monitors: [monitor({ id: "m_api", checked: false, state: "unchecked" })] });
    expect(viewFromSim(unchecked, page({ components: [component({ id: "c", monitorIds: ["m_api"] })] })).updatedAt).toBeNull();
  });
});
