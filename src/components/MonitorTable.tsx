"use client";

import Link from "next/link";
import type { Monitor, Sim } from "@/lib/model";
import { typeLabel } from "@/lib/model";
import { ms, pct, time } from "@/lib/format";
import { sslLine } from "@/lib/expiry";
import { newestReport, noNumber, recoveryNote, reportedWhen, reportResult, stateLabel, versionSince } from "@/lib/history";
import { awaitingNumbers } from "@/lib/poll";
import { useEagerPoll } from "@/lib/workspace-store";
import { locations } from "@/lib/plans";
import { StateBadge } from "./State";
import { TypeIcon } from "./TypeIcon";

/** Shared monitor identity, without a state/history claim. Previews omit the link and may
 * withhold the target entirely; dashboard rows retain their existing target formatting. */
export function MonitorIdentity({ monitor: m, href }: {
  monitor: Pick<Monitor, "name" | "type"> & Partial<Pick<Monitor, "target">>; href?: string;
}) {
  return <div className="mon-name">
    <TypeIcon type={m.type} />
    <span className="sr-only">{typeLabel[m.type]}: </span>
    <div className="grow">
      {href ? <Link href={href}>{m.name}</Link> : <span className="mon-title">{m.name}</span>}
      {m.target !== undefined && <span className="mon-target addr">{m.type === "heartbeat" ? m.target : m.target.replace(/^https:\/\//, "")}</span>}
    </div>
  </div>;
}

/** The "Latest checks" cell: the newest 5-minute window any location reported, and where from. An
 *  SSL monitor whose certificate a check has read gives its two expiries instead. */
export function lastLine(m: Monitor, now: number): { main: string; sub: string } {
  if (m.type === "heartbeat" && m.hb && !m.hb.lastPingAt) return { main: "No ping yet", sub: m.hb.scheduleLabel };
  const expiry = m.type === "ssl" ? sslLine(m.ssl) : null;
  if (expiry) return { main: expiry, sub: "checked every 6 hours" };
  if (m.type === "heartbeat" && m.hb) {
    const hb = m.hb;
    const down = m.state === "down";
    const at = time(hb.lastPingAt);
    // Down with a newest good ping whose assertions held: the run after it never finished.
    const missed = down && hb.lastKind === "ping" && (m.assertions ?? []).every((a) => a.pass !== false);
    const main =
      hb.runningSince !== null ? `Started at ${time(hb.runningSince)}, ${down ? "no finish" : "running"}`
      : hb.lastKind === "fail" ? `/fail at ${at}`
      : missed ? `No ping since ${at}`
      : `Ping at ${at}${hb.summary ? `, ${hb.summary[0]} ${hb.summary[1]}` : ""}`;
    return { main, sub: hb.scheduleLabel };
  }
  const r = newestReport(m);
  if (!r) return { main: noNumber(m), sub: "" };
  return { main: reportResult(r), sub: `${reportedWhen(r, now, versionSince(m))} from ${locations[r.loc].city}` };
}

export function MonitorTable({ s, monitors, showApp }: { s: Sim; monitors: Monitor[]; showApp?: boolean }) {
  // A row about to get its first numbers refreshes the screen every few seconds until it has them.
  useEagerPoll(monitors.some((m) => awaitingNumbers(m, s.now)));
  return (
    <div className="scroll-x">
      <table className="table">
        <thead>
          <tr>
            <th>Monitor</th>
            {showApp && <th className="hide-sm">App</th>}
            <th>State</th>
            <th className="hide-sm">Latest checks</th>
            <th className="r hide-sm">Response</th>
            <th className="r">24 h</th>
          </tr>
        </thead>
        <tbody>
          {monitors.map((m) => {
            const line = lastLine(m, s.now);
            const r = newestReport(m);
            const up = m.uptime.day.pct;
            return (
              <tr key={m.id}>
                <td>
                  <MonitorIdentity monitor={m} href={`/app/monitors/${m.id}`} />
                </td>
                {showApp && <td className="hide-sm">{s.apps.find((a) => a.id === m.appId)?.name}</td>}
                <td>
                  <StateBadge state={m.state} label={stateLabel(m)} />
                </td>
                <td className="hide-sm">
                  <div>{line.main}</div>
                  {line.sub && <div className="t-meta">{line.sub}</div>}
                  {/* Only where Down sits beside a pass: under a failure the rule would be noise. */}
                  {r && r.checks > 0 && r.failures === 0 && recoveryNote(m) && <div className="t-meta">{recoveryNote(m)}</div>}
                </td>
                {/* The newest window's median, from the location in the cell beside it. */}
                <td className="r num hide-sm">{ms(r?.p50)}</td>
                <td className="r num">{m.type === "ssl" || up === null ? "—" : pct(up)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
