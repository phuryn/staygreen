/* What an alert says (`spec.md § 5`, Content), built from an incident row. One function per
   message, used by the sender for every email and by the Alerts screen for its preview, so the
   preview is the message (`.claude/skills/design/references/method.md`: every summary of one
   state comes from one function).

   Plain text that reads on a phone's lock screen: the subject is the app and what broke, and the
   body's first line is what failed. The evidence is what the incident already holds, masked
   again here in case anything older than the masker reached a row. Times are in the recipient's
   time zone when Clerk has one for them, otherwise UTC, and say which.

   Pure and relative-imported, so it runs in the browser, in Next, and in the sender outside Next
   (the sender Worker cron). */

import { mask } from "../../checks/mask";
import { dur } from "../format";
import { isLocationId, locations } from "../plans";

export type Evidence = {
  request?: string;
  summary?: string;
  status?: number;
  assertion?: string;
  got?: string;
  locations?: string[];
  snippet?: string;
};

export type AlertIncident = {
  id: string;
  title: string;
  severity: string;
  openedAt: number;
  resolvedAt: number | null;
  evidence: Evidence;
};

/** What the incident is about, named the way every screen names it. */
export type AlertAbout = { appName: string; monitorName: string; monitorType: string; pageSlug: string | null };

export type Message = { subject: string; lines: string[] };

const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const stop = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/** The zone itself, or UTC when there is none or it isn't one Intl knows. */
export function zoneOf(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "14:02 UTC on 22 October", or "14:02 CEST on 22 October" in a recipient's own zone. A zone
 *  with no abbreviation in English reads as its offset, "UTC-4". */
export function when(t: number, tz?: string | null): string {
  const timeZone = zoneOf(tz);
  const d = new Date(t);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long" }).format(d);
  const name =
    timeZone === "UTC"
      ? "UTC"
      : (new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "UTC")
          .replace(/^GMT$/, "UTC")
          .replace(/^GMT(?=[+-])/, "UTC");
  return `${clock} ${name} on ${date}`;
}

const cities = (ids: readonly string[] = []) => [...new Set(ids.filter(isLocationId).map((l) => locations[l].city))];

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** The request as an alert shows it, outside the workspace: the method and the address without
 *  its query string or fragment, which can carry a key too short or too plain for the masker to
 *  know (`?token=abc123`), then masked like the rest. The incident page keeps the whole URL. */
export function requestLine(request: string | undefined): string {
  return mask((request ?? "").trim().replace(/[?#]\S*/, ""));
}

/** Alert recipients can be a wider audience than the dashboard. Query values from the
 *  monitored request are credentials even when too short/plain for the general masker.
 *  Mask only evidence text, not incident ids, dates or the dashboard/status links. */
export function maskAlertText(text: string, request?: string): string {
  let values: string[] = [];
  try { values = [...new URL((request ?? "").replace(/^\S+\s+/, ""), "https://redact.invalid").searchParams.values()].filter(Boolean); } catch { /* No parseable query. */ }
  let out = mask(text, values);
  for (const value of values.filter((v) => v.length < 4)) {
    const json = JSON.stringify(value).slice(1, -1);
    for (const form of [encodeURIComponent(value), json.replaceAll("/", "\\/"), json, value].sort((a, b) => b.length - a.length))
      out = out.split(form).join("•••");
  }
  return out;
}

/** What failed, in plain words, with the evidence the incident holds. */
export function evidenceLine(e: Evidence, monitorType: string): string {
  const summary = maskAlertText(e.summary ?? "", e.request).trim();
  const request = requestLine(e.request);
  // An assertion's expected value is something a member typed, and can be a key.
  const assertion = e.assertion ? maskAlertText(e.assertion, e.request) : "";
  // A failed assertion on an answer that came back reads as the spec's own example.
  if (assertion && request && typeof e.status === "number" && monitorType !== "heartbeat") {
    const got = e.got !== undefined && e.got !== "" ? `: got ${maskAlertText(e.got, e.request)}` : "";
    return `${request} returned ${e.status}, but ${assertion} failed${got}.`;
  }
  let line: string;
  if (!summary) line = request ? `${request} failed.` : "";
  else if (monitorType === "heartbeat" || !request) line = stop(cap(summary));
  // "GET /api/health returned 200, but …" reads as one sentence; a capitalised summary follows a colon.
  else if (/^[a-z]/.test(summary)) line = stop(`${request} ${summary}`);
  else line = stop(`${request}: ${summary}`);
  if (assertion && !summary.includes(assertion)) {
    const got = e.got !== undefined && e.got !== "" ? `: got ${maskAlertText(e.got, e.request)}` : "";
    line = `${line} ${stop(`${assertion} failed${got}`)}`.trim();
  }
  return line;
}

export type Links = { incidentUrl: string; pageUrl: string | null };

export function linksFor(appUrl: string, incidentId: string, pageSlug: string | null): Links {
  const base = appUrl.replace(/\/+$/, "");
  return { incidentUrl: `${base}/app/incidents/${incidentId}`, pageUrl: pageSlug ? `${base}/s/${pageSlug}` : null };
}

function linkLines(incidentId: string, links: Links): string[] {
  return [`Incident ${incidentId}: ${links.incidentUrl}`, ...(links.pageUrl ? [`Status page: ${links.pageUrl}`] : [])];
}

/** An incident opening: `askone: API health is down`, then what failed, where and since when. */
export function composeOpened(inc: AlertIncident, about: AlertAbout, links: Links, tz?: string | null): Message {
  const where = cities(inc.evidence.locations);
  const since = when(inc.openedAt, tz);
  const snippet = maskAlertText(inc.evidence.snippet ?? "", inc.evidence.request).trim();
  const evidence = evidenceLine(inc.evidence, about.monitorType);
  return {
    subject: `${about.appName}: ${inc.title}`,
    lines: [
      ...(evidence ? [evidence] : []),
      where.length ? `Seen from ${list(where)} since ${since}.` : `Since ${since}.`,
      ...(snippet ? ["", "What came back, masked:", snippet] : []),
      "",
      ...linkLines(inc.id, links),
    ],
  };
}

/** Its recovery: how long it was down, and what ended it. */
export function composeResolved(inc: AlertIncident, about: AlertAbout, links: Links, stateAfter: string | null, tz?: string | null): Message {
  const end = inc.resolvedAt ?? inc.openedAt;
  const how = about.monitorType === "heartbeat" ? "A good ping arrived" : "It passed twice in a row";
  return {
    subject: `${about.appName}: ${about.monitorName} recovered`,
    lines: [
      `Down for ${dur(end - inc.openedAt)}. ${how} at ${when(end, tz)}.`,
      ...(stateAfter === "degraded" ? ["It's answering again, but slowly, so it reads as degraded."] : []),
      "",
      ...linkLines(inc.id, links),
    ],
  };
}

/** A test from the Alerts screen, through the same path as an alert. */
export function composeTest(appUrl: string, tz?: string | null, at = Date.now()): Message {
  return {
    subject: "Staygreen: test alert",
    lines: [
      `A test of your Staygreen alerts, sent at ${when(at, tz)}.`,
      "When a monitor goes down, its alert arrives here like this one: the app and what broke, what failed with the evidence, where it was seen from and since when, and links to the incident and the status page. A second message follows when it recovers.",
      "",
      `Alerts: ${appUrl.replace(/\/+$/, "")}/app/alerts`,
    ],
  };
}

export type Footer = { why: string; unsubscribeUrl: string };

/** Why the recipient gets it, in words true for the channel that reached them. */
export function whyLine(audience: "members" | "address" | "chat", appName: string | null): string {
  if (audience === "chat") {
    return appName
      ? `You get this because this chat was connected to the Staygreen workspace that monitors ${appName}.`
      : "You get this because this chat was connected to a Staygreen workspace.";
  }
  if (audience === "members") {
    return appName
      ? `You get this because you're a member of the Staygreen workspace that monitors ${appName}.`
      : "You get this because you're a member of a Staygreen workspace and asked for a test.";
  }
  return appName
    ? `You get this because this address was added to get Staygreen alerts for ${appName}, and confirmed.`
    : "You get this because this address was added to get a Staygreen workspace's alerts, and confirmed.";
}

/** The whole plain-text body. */
export function emailText(m: Message, footer: Footer): string {
  return [...m.lines, "", "--", footer.why, `Stop these emails: ${footer.unsubscribeUrl}`, ""].join("\n");
}

/** The email that asks an address that isn't a member's whether it wants the workspace's alerts.
 *  Nothing more goes to it until its owner follows the link, and ignoring it is the way to say no. */
export function composeConfirm(appNames: string[], confirmUrl: string, maxAgeDays: number): Message {
  const apps = appNames.length ? ` for ${list(appNames.slice(0, 3))}${appNames.length > 3 ? " and more" : ""}` : "";
  return {
    subject: "Confirm Staygreen alerts",
    lines: [
      `A member of a Staygreen workspace asked to send its uptime alerts${apps} to this address.`,
      "",
      `To get them, confirm here within ${maxAgeDays} days:`,
      confirmUrl,
      "",
      "If you didn't expect this, ignore it. Nothing more is sent to this address unless it is confirmed.",
    ],
  };
}
