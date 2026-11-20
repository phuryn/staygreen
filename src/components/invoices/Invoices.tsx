"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { loadOrganizationInvoicePage, type InvoicePageState } from "@/app/invoice-page-actions";
import { attempt, UNREACHABLE } from "@/lib/action-call";
import type { InvoiceFilters } from "@/lib/invoices/contract";
import type { InvoiceListItem } from "@/lib/invoices/page-model";
import { ProfilePage, ProfileSection } from "../ui";
import { InvoiceBillingDetails } from "./InvoiceBillingDetails";
import { InvoiceCorrectionDialog } from "./InvoiceCorrectionDialog";
import { InvoiceList } from "./InvoiceList";

export function settleInvoicePage(current: InvoicePageState, next: InvoicePageState): InvoicePageState {
  const recoverable = !next.items && (next.code === "unavailable" || next.code === "invalid_filter" || next.code === undefined);
  return current.items && recoverable ? { ...current, error: next.error, code: next.code } : next;
}

export function Invoices({ organization }: { organization: string }) {
  const [state, setState] = useState<InvoicePageState>({});
  const [filters, setFilters] = useState<InvoiceFilters>({});
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<InvoiceListItem>();
  const [busy, setBusy] = useState(false);
  const latestLoad = useRef(0);
  const lastQuery = useRef<InvoiceFilters>({});
  const correctionRequests = useRef(new Map<string, string>());
  const invoiceRequests = useRef(new Map<string | undefined, string>());

  async function load(query = filters) {
    const loadId = ++latestLoad.current;
    lastQuery.current = query;
    setBusy(true);
    const result: InvoicePageState = await attempt(() => loadOrganizationInvoicePage(query));
    if (loadId !== latestLoad.current) return false;
    const next: InvoicePageState = result.items && result.organization !== organization
      ? { code: "organization_changed", error: "Your active workspace changed. Reopen Invoices to continue." }
      : result.error === UNREACHABLE ? { code: "unavailable", error: "Couldn’t load invoices. Try again." } : result;
    setState(current => settleInvoicePage(current, next));
    if (next.items) setFilters(query);
    if (next.code === "organization_changed" || next.code === "permission") {
      setEditing(false);
      setSelected(undefined);
    }
    setBusy(false);
    return !!next.items;
  }

  useEffect(() => {
    void load({});
    return () => { latestLoad.current++; };
  }, [organization]);

  return (
    <ProfilePage title="Invoices">
      {state.sample && <p className="callout"><Info aria-hidden="true" /><span>This page shows sample data. Changes reset when the server restarts.</span></p>}
      {state.error && (
        <div className="stack-sm">
          <p role="alert" className="error">{state.error}</p>
          {state.code !== "permission" && state.code !== "organization_changed" &&
            <div className="cluster"><button className="btn" type="button" disabled={busy} onClick={() => load(lastQuery.current)}>Try again</button></div>}
        </div>
      )}
      {!state.items && !state.error && <>
        <ProfileSection title="Billing details"><p className="t-meta" role="status">Loading billing details…</p></ProfileSection>
        <ProfileSection title="Documents" wide><p className="t-meta">Loading invoices…</p></ProfileSection>
      </>}
      {state.items && state.billing && state.organization && <>
        <InvoiceBillingDetails
          billing={state.billing} organization={state.organization} canManage={!!state.canManage}
          editing={editing} onEditing={setEditing}
          onSaved={billing => {
            setState(current => ({ ...current, billing }));
            setEditing(false);
            void load();
          }}
          onReload={async () => { if (await load()) setEditing(false); }}
        />
        <InvoiceList
          items={state.items} filters={filters} busy={busy} organization={state.organization} canManage={!!state.canManage}
          editing={editing} requests={invoiceRequests.current} onLoad={load} onCorrect={setSelected}
        />
        {selected && <InvoiceCorrectionDialog
          item={selected} billing={state.billing} organization={state.organization} requests={correctionRequests.current}
          onClose={requested => {
            setSelected(undefined);
            if (requested) void load();
          }}
        />}
      </>}
    </ProfilePage>
  );
}
