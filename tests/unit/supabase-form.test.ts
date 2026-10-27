import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/authz";
import { supabaseReadSql } from "@/lib/service-monitor";
import type { Workspace } from "@/lib/workspace-store";
import { monitor, NOW, sim } from "./fixtures";

vi.mock("@/lib/workspace-store", () => ({ useActs: () => ({}), useAppSelection: () => ({ app: "app_1" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/Copy", () => ({
  Copy: ({ text, label }: { text: string; label: string }) => createElement("button", { "data-copies": text }, label),
}));

import { MonitorForm } from "@/app/(app)/app/monitors/new/AddMonitorScreen";

const s: Workspace = {
  ...sim({ apps: [{ id: "app_1", name: "Example", url: "https://example.com", logoUrl: null, blurb: "", channelIds: [] }] }),
  loadedAt: NOW, features: [], can: Object.fromEntries(PERMISSIONS.map((p) => [p, true])) as Workspace["can"],
};
const form = (type: "supabase" | "stripe", databaseRead?: string) => renderToStaticMarkup(createElement(MonitorForm, {
  s, type, appId: "app_1", appUrl: "https://example.com", full: true, onDone: vi.fn(),
  editing: databaseRead === undefined ? undefined : monitor({ id: "mon_1", appId: "app_1", type, serviceConfig: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead } }),
}));
const at = (html: string, id: string) => html.indexOf(`id="${id}"`);

describe("the Supabase form", () => {
  it("asks for the project URL, then the publishable key, then the read (owner, 2026-10-26)", () => {
    const html = form("supabase");
    expect(at(html, "projectUrl")).toBeGreaterThan(-1);
    expect(at(html, "projectUrl")).toBeLessThan(at(html, "serviceKey"));
    expect(at(html, "serviceKey")).toBeLessThan(at(html, "databaseRead"));
    expect(html).toContain("Publishable key");
  });
  it("offers the view's SQL with a copy button, named as the read was typed", () => {
    expect(form("supabase")).toContain(`data-copies="${supabaseReadSql("")}"`);
    const named = form("supabase", "uptime_probe");
    expect(named).toContain(`data-copies="${supabaseReadSql("uptime_probe")}"`);
    expect(named).toContain("public.uptime_probe");
    expect(named).toContain("Copy SQL");
  });
  it("offers no view for an rpc/ read", () => {
    const html = form("supabase", "rpc/health");
    expect(html).not.toContain("SQL for a one-row health view");
    expect(html).not.toContain("Copy SQL");
  });
  it("keeps Stripe's key first, before its endpoints", () => {
    const html = form("stripe");
    expect(at(html, "serviceKey")).toBeGreaterThan(-1);
    expect(at(html, "serviceKey")).toBeLessThan(at(html, "endpoints"));
    expect(html).not.toContain('id="projectUrl"');
  });
});

describe("the SQL offered for a Supabase database read", () => {
  it("names the view as typed once it is a table or view name", () => {
    expect(supabaseReadSql(" uptime_probe ")).toBe(
      "create view public.uptime_probe with (security_invoker = true) as select true as ok;\ngrant select on public.uptime_probe to anon;",
    );
  });
  // A reserved word needs no quotes after `public.`: PostgreSQL 17 creates and serves `public.order` (review ui26).
  it.each(["", "rpc/health", "Not A Name", "a;drop table x"])("falls back to staygreen_health for %j", (read) => {
    const sql = supabaseReadSql(read);
    expect(sql).toContain("create view public.staygreen_health ");
    expect(sql).toContain("grant select on public.staygreen_health to anon;");
  });
});
