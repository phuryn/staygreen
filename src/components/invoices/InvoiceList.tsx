"use client";

import { Fragment, useState, useTransition } from "react";
import { Check, ChevronDown, Clock, FileDown, FilePenLine } from "lucide-react";
import { requestInvoiceNow, type CorrectionState } from "@/app/invoice-page-actions";
import { attempt } from "@/lib/action-call";
import type { InvoiceDocument, InvoiceFilters } from "@/lib/invoices/contract";
import { correctionReason, invoiceDate, invoicePdfHref, money, requestIdFor, settleRequestId, type InvoiceListItem } from "@/lib/invoices/page-model";
import { ProfileSection } from "../ui";

type Props = {
  items: InvoiceListItem[]; filters: InvoiceFilters; busy: boolean; editing: boolean;
  organization: string; canManage: boolean;
  requests: Map<string | undefined, string>;
  onLoad: (filters?: InvoiceFilters) => Promise<boolean>; onCorrect: (item: InvoiceListItem) => void;
};

export function InvoiceList({ items, filters, busy, editing, organization, canManage, requests, onLoad, onCorrect }: Props) {
  const filtered = Object.values(filters).some(Boolean);
  return (
    <ProfileSection title="Documents" wide>
      <div className="spread">
        <InvoiceSearch key={JSON.stringify(filters)} filters={filters} busy={busy} onSearch={onLoad} />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onLoad()}>{busy ? "Loading invoices…" : "Refresh invoices"}</button>
      </div>
      {items.length ? (
        <div className="panel panel-flush table-container">
          <table className="table table-responsive" role="table" aria-label="Invoice documents">
            <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Document</th><th scope="col" role="columnheader">Date</th><th scope="col" role="columnheader">Amount</th><th scope="col" role="columnheader">Actions</th></tr></thead>
            <tbody role="rowgroup">
              {items.map(item => (
                <Fragment key={item.id}>
                  <InvoiceRow document={item} correctionPending={item.correctionBlock === "pending"} corrected={item.corrections.length > 0}>
                    {canManage && item.kind === "invoice" && (item.status === "issued"
                      ? <CorrectionAction item={item} editing={editing} onCorrect={onCorrect} />
                      : item.payment_ref !== null && <InvoiceRequest paymentRef={item.payment_ref} organization={organization} requests={requests} onReload={onLoad} />)}
                  </InvoiceRow>
                  {item.corrections.map(document => <InvoiceRow key={document.id} document={document} parentNumber={item.number} />)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="well stack-sm">
          <h3 className="t-strong">{filtered ? "No documents match" : "No invoices yet"}</h3>
          <p className="t-2">{filtered ? "Try another document number or date range." : "When the issuer has an invoice for this workspace, it appears here."}</p>
          {filtered && <div><button type="button" className="btn" disabled={busy} onClick={() => onLoad({})}>Clear search</button></div>}
        </div>
      )}
      {canManage && <InvoiceRequest organization={organization} requests={requests} onReload={onLoad} />}
    </ProfileSection>
  );
}

function InvoiceSearch({ filters, busy, onSearch }: {
  filters: InvoiceFilters; busy: boolean; onSearch: (filters: InvoiceFilters) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(Object.values(filters).some(Boolean));
  const [draft, setDraft] = useState(filters);
  return (
    <details className="disclosure disclosure-fields" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Search invoices<ChevronDown aria-hidden="true" className="disclosure-chev" /></summary>
      <form onSubmit={event => { event.preventDefault(); if (!busy) void onSearch(draft); }}>
        <fieldset className="stack-sm" disabled={busy}>
          <div className="field-columns">
            <label className="field"><span className="label">Document number</span>
              <input className="input" value={draft.number ?? ""} maxLength={64} placeholder="Number or beginning of it"
                onChange={event => setDraft({ ...draft, number: event.target.value || undefined })} />
            </label>
            <label className="field"><span className="label">Document kind</span>
              <select className="select" value={draft.kind ?? ""} onChange={event => {
                const value = event.target.value;
                setDraft({ ...draft, kind: value === "invoice" || value === "correction" ? value : undefined });
              }}>
                <option value="">All documents</option><option value="invoice">Invoices</option><option value="correction">Corrections</option>
              </select>
            </label>
            <label className="field"><span className="label">From date</span>
              <input className="input" type="date" value={draft.from ?? ""} onChange={event => setDraft({ ...draft, from: event.target.value || undefined })} />
            </label>
            <label className="field"><span className="label">To date</span>
              <input className="input" type="date" value={draft.to ?? ""} onChange={event => setDraft({ ...draft, to: event.target.value || undefined })} />
            </label>
          </div>
          <p className="hint">Search by issue date, or by payment date for a pending invoice.</p>
          <div className="cluster"><button className="btn" type="submit">Search</button>
            <button className="btn" type="button" onClick={() => { setDraft({}); void onSearch({}); }}>Clear search</button>
          </div>
        </fieldset>
      </form>
    </details>
  );
}

function InvoiceRow({ document, parentNumber, correctionPending, corrected, children }: {
  document: InvoiceDocument; parentNumber?: string | null; correctionPending?: boolean; corrected?: boolean; children?: React.ReactNode;
}) {
  const issued = document.status === "issued";
  const correction = document.kind === "correction";
  const pending = !issued || correctionPending;
  const Icon = pending ? Clock : correction || corrected ? FilePenLine : Check;
  const status = !issued ? (!correction && !document.payment_date ? "Invoice requested" : "Being issued")
    : correction ? "Correction" : correctionPending ? "Correction being issued" : corrected ? "Corrected" : "Issued";
  const date = issued && document.issue_date ? invoiceDate(document.issue_date)
    : document.payment_date ? `Paid ${invoiceDate(document.payment_date)}` : "—";
  return (
    <tr role="row" className={correction ? "table-row-related" : undefined}>
      <td role="cell" className="wrap-anywhere">
        <div className="stack-sm">
          {issued && <span>{document.number}</span>}
          {correction ? <span className="t-meta">{correctionReason(document.reason)} · Corrects {parentNumber ?? "another invoice"}</span>
            : document.description && <span className="t-meta">{document.description}</span>}
          <div><span className="tag"><Icon aria-hidden="true" />{status}</span></div>
        </div>
      </td>
      <td role="cell"><span className="table-mobile-label" aria-hidden="true">Date </span>{date}</td>
      <td role="cell" className="wrap-anywhere">
        <span className="table-mobile-label" aria-hidden="true">{correction ? "Change " : "Amount "}</span>
        {document.gross === null ? "—" : money(document.gross, document.currency)}
        {correction && document.gross !== null && <span className="table-desktop-note t-meta">Change</span>}
      </td>
      <td role="cell">
        <div className="stack-sm">
          {issued && <div className="cluster"><a href={invoicePdfHref(document.id)} download className="btn btn-sm" aria-label={`Download ${document.number} PDF`}>
            <FileDown aria-hidden="true" /> PDF
          </a></div>}
          {children}
        </div>
      </td>
    </tr>
  );
}

function CorrectionAction({ item, editing, onCorrect }: { item: InvoiceListItem; editing: boolean; onCorrect: (item: InvoiceListItem) => void }) {
  if (item.canCorrect && !editing) return (
    <div><button type="button" className="btn btn-sm" onClick={() => onCorrect(item)} aria-label={`Correct ${item.number}`}>Correct…</button></div>
  );
  if (item.correctionBlock === "billing_details") return <p className="t-meta">Save billing details to correct this invoice.</p>;
  if (item.correctionBlock === "closed") return <p className="t-meta">{item.correctable_until ? "Correction window closed." : "No correction window is available."}</p>;
  if (item.canCorrect && editing) return <p className="t-meta">Finish editing billing details to request a correction.</p>;
  return null;
}

function InvoiceRequest({ paymentRef, organization, requests, onReload }: {
  paymentRef?: string; organization: string; requests: Map<string | undefined, string>; onReload: () => Promise<boolean>;
}) {
  const [state, setState] = useState<CorrectionState>({});
  const [busy, start] = useTransition();
  const refused = ["already_invoiced", "request_open", "organization_changed", "permission"].includes(state.code ?? "");
  return (
    <div className="stack-sm">
      {paymentRef === undefined && !state.document && <p className="t-meta">If you paid and don&apos;t see an invoice here, you can ask the issuer for it.</p>}
      {!state.document && !refused && <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => {
        const id = requestIdFor(requests, paymentRef);
        start(async () => {
          const next: CorrectionState = await attempt(() => requestInvoiceNow({ organization, request_id: id, payment_ref: paymentRef }));
          setState(next);
          settleRequestId(requests, paymentRef, next);
          if (next.document) void onReload();
        });
      }}>{busy ? "Sending request…" : state.error ? "Retry request" : paymentRef === undefined ? "Missing an invoice?" : "Issue now"}</button></div>}
      {state.document && <p className="t-meta" role="status">Request sent to the issuer.</p>}
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {refused && state.code !== "organization_changed" && state.code !== "permission" &&
        <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => start(async () => { await onReload(); })}>Reload invoices</button></div>}
    </div>
  );
}
