import { Check, Minus } from "lucide-react";
import { builderOnlyLocations, builderRegion, cities, list, places } from "@/components/landing/plan-copy";
import { isLive } from "@/lib/launch";
import { has, limits, type Limits, type PlanId } from "@/lib/plans";
import { SoonTag } from "./Tags";

// Free vs Builder, from spec.md § 1. Used by pricing and billing so the two never disagree.
// Every number and every Builder-only switch is read from the plan module; the few values
// spec.md § 1 gives the same on both plans and the module doesn't carry (DNS interval, alert
// channels, own domain, the subscriber cap) are written here once.

type Cell = string | boolean;
type Row = { label: string; free: Cell; builder: Cell; soon?: boolean; builderSoon?: boolean };

const F = limits.free;
const B = limits.builder;
const both = (f: (l: Limits, plan: PlanId) => Cell) => ({ free: f(F, "free"), builder: f(B, "builder") });
const mins = (n: number) => `every ${n} min`;
const capped = (n: number | "cap") => (n === "cap" ? "within your monitor limit" : String(n));

const groups: { title: string; rows: Row[] }[] = [
  {
    title: "Monitoring",
    rows: [
      { label: "Apps, each with its own status page", ...both((l) => String(l.apps)) },
      { label: "Monitors", ...both((l) => String(l.monitors)) },
      { label: "Monitors per host (SSL excluded)", ...both((l) => String(l.perHost)) },
      { label: "HTTP and TCP checks", ...both((l) => mins(l.httpIntervalMin)) },
      {
        label: "Check locations",
        free: list(places(F.locations)),
        builder: builderOnlyLocations.length ? `adds ${list(cities(builderOnlyLocations))}, in ${builderRegion}` : list(cities(B.locations)),
        builderSoon: !isLive("frankfurt"),
      },
      { label: "JSON and keyword assertions per HTTP monitor", ...both((l) => String(l.assertions)) },
      {
        label: "Heartbeats for crons and jobs",
        free: `${F.heartbeats}, ${F.heartbeatAssertions === 1 ? "one assertion" : `${F.heartbeatAssertions} assertions`} each`,
        builder: `${B.heartbeats}, up to ${B.heartbeatAssertions} each`,
      },
      { label: "SSL certificate and domain expiry", free: "every host, automatically", builder: "every host, automatically" },
      { label: "Stripe webhook failures", ...both((l) => `${mins(l.stripePollMin)}, ${l.stripeAccounts} ${l.stripeAccounts === 1 ? "account" : "accounts"}`) },
      { label: "DNS records", free: mins(10), builder: mins(10) },
      { label: "Monitoring your own MCP server", ...both((l) => capped(l.mcpMonitors)), soon: !isLive("mcp") },
      { label: "Supabase projects", ...both((l) => capped(l.supabaseMonitors)), soon: !isLive("supabase") },
    ],
  },
  {
    title: "Alerts",
    rows: [
      { label: "Email, Telegram, Slack, Discord, signed webhook", free: true, builder: true },
      { label: "Confirmation from a second location, recovery notices", free: true, builder: true },
      { label: "Route incidents and warnings to different channels", ...both((_, p) => has(p, "alert_rules")) },
      { label: "Alert delay and repeat while down", ...both((_, p) => has(p, "alert_rules")), soon: !isLive("alertTiming") },
      { label: "Maintenance windows", ...both((_, p) => has(p, "alert_rules")), soon: !isLive("maintenanceWindows") },
      { label: "Teammates who get alerts without an account", ...both((_, p) => (has(p, "notify_teammates") ? "unlimited" : false)) },
    ],
  },
  {
    title: "Status pages and widget",
    rows: [
      { label: "Status pages", ...both((l) => String(l.statusPages)) },
      { label: "Your own domain with automatic HTTPS", free: true, builder: true, soon: !isLive("customDomains") },
      { label: "Logo, accent colour, light or dark", free: true, builder: true },
      { label: "In-app incident banner and status pill", free: true, builder: true, soon: !isLive("widget") },
      { label: "README badge", free: true, builder: true, soon: !isLive("badge") },
      { label: "Remove \"Powered by Staygreen\"", ...both((_, p) => has(p, "white_label")) },
      { label: "Members-only pages, hide from search engines", ...both((_, p) => has(p, "private_pages")) },
      { label: "Email subscribers", ...both((_, p) => (has(p, "subscribers") ? "1,000 per page" : false)), soon: !isLive("subscribers") },
    ],
  },
  {
    title: "Agents and history",
    rows: [
      { label: "MCP server and REST API for your coding agent", ...both((l) => `${l.apiPerMin} calls a minute`) },
      { label: "History", ...both((l) => l.historyLabel) },
      { label: "CSV export", ...both((_, p) => has(p, "history_1y")), soon: !isLive("csvExport") },
      { label: "Commercial use", free: true, builder: true },
    ],
  },
];

function Val({ v }: { v: Cell }) {
  if (v === true) return <span className="plan-yes"><Check aria-hidden="true" /><span className="sr-only">Included</span></span>;
  if (v === false) return <span className="plan-no"><Minus aria-hidden="true" /><span className="sr-only">Not included</span></span>;
  return <>{v}</>;
}

export function PlanTable({ highlight }: { highlight?: "free" | "builder" }) {
  return (
    <div className="scroll-x plan-table">
      <table className="table">
        <caption className="sr-only">What Free and Builder include</caption>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col" aria-current={highlight === "free" ? "true" : undefined}>Free</th>
            <th scope="col" aria-current={highlight === "builder" ? "true" : undefined}>Builder</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.title}>
            <tr className="plan-group">
              <th scope="rowgroup" colSpan={3}>{g.title}</th>
            </tr>
            {g.rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">
                  <span className="cluster">
                    {r.label}
                    {r.soon && <SoonTag />}
                  </span>
                </th>
                <td><Val v={r.free} /></td>
                <td><Val v={r.builder} />{r.builderSoon && <> <SoonTag /></>}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
