"use client";

import { useId, useState, useTransition } from "react";
import { askForInvoiceCorrection, type CorrectionState } from "@/app/invoice-page-actions";
import { attempt } from "@/lib/action-call";
import type { BillingResponse, Buyer } from "@/lib/invoices/contract";
import { buyerAddress, changesPrintedTaxId, invoiceDate, movesConsumerCountry, requestIdFor, settleRequestId, type InvoiceListItem } from "@/lib/invoices/page-model";
import { Modal, ModalBody, ModalFoot } from "../ui";

const refusedCodes = ["not_correctable", "correction_pending", "permission", "not_found", "nothing_to_correct", "organization_changed"];

export function InvoiceCorrectionDialog({ item, billing, organization, requests, onClose }: {
  item: InvoiceListItem; billing: BillingResponse; organization: string; requests: Map<string, string>; onClose: (requested: boolean) => void;
}) {
  const [state, setState] = useState<CorrectionState>({});
  const [busy, start] = useTransition();
  const summary = useId();
  const details = billing.details;
  const changesTaxId = changesPrintedTaxId(item.buyer, details);
  const movesCountry = movesConsumerCountry(item.buyer, details);
  const refused = changesTaxId || movesCountry || !details || refusedCodes.includes(state.code ?? "");
  const requested = !!state.document;
  const close = () => onClose(requested);

  function request() {
    // The page owns the id, so closing and reopening the dialog after a network error retries the same request.
    const id = requestIdFor(requests, item.id);
    start(async () => {
      const next: CorrectionState = await attempt(() => askForInvoiceCorrection({ organization, documentId: item.id, request_id: id }));
      setState(next);
      settleRequestId(requests, item.id, next);
    });
  }

  // Keep the correction dialog open until the Server Action settles.
  return (
    <Modal open nested wide undismissable={busy} onClose={close} describedBy={summary}>
      <ModalBody title={requested ? "Correction requested" : `Correct ${item.number}?`}>
        {requested ? <p id={summary} role="status">Correction requested for {item.number}. Refresh invoices to check its progress.</p> : <>
          <p id={summary} className="t-2">The issuer uses your saved billing details for the correction.</p>
          <div className="field-columns">
            <CorrectionSide title="Buyer as printed" buyer={item.buyer} />
            <CorrectionSide title="Saved billing details" buyer={details} address={details ? buyerAddress(details) : undefined} />
          </div>
          {item.correctable_until && <p className="t-meta">Request by {invoiceDate(item.correctable_until)}, inclusive (Warsaw time).</p>}
          {!details && <p className="t-2">Save billing details before requesting a correction.</p>}
          {(changesTaxId || movesCountry) && (
            <div className="stack-sm">
              <p className="t-2">{changesTaxId
                ? "Changing or removing a printed VAT ID requires the issuer to cancel and reissue this invoice."
                : "Moving an invoice without a VAT ID to another country changes its VAT, so the issuer handles it by hand."} Contact support with the invoice number.</p>
              <div><a className="btn" href="/support" target="_blank" rel="noopener noreferrer">Contact support</a></div>
            </div>
          )}
          {state.error && <p className="error" role="alert">{state.error}</p>}
        </>}
      </ModalBody>
      <ModalFoot>
        {requested ? <button className="btn" type="button" ref={element => element?.focus()} onClick={close}>Done</button> : <>
          <button className="btn" type="button" data-modal-autofocus disabled={busy} onClick={close}>{refused ? "Close" : "Cancel"}</button>
          {!refused && <button className="btn btn-primary" type="button" disabled={busy} onClick={request}>{busy ? "Sending request…" : state.error ? "Retry correction" : "Ask for correction"}</button>}
        </>}
      </ModalFoot>
    </Modal>
  );
}

function CorrectionSide({ title, buyer, address }: { title: string; buyer: Buyer | null; address?: string }) {
  return (
    <div className="well stack-sm wrap-anywhere">
      <h3 className="t-strong">{title}</h3>
      {buyer ? <>
        <p>{buyer.name}</p><p className="t-meta">{address ?? buyer.country}</p>
        <p className="t-meta">{buyer.tax_id ? `VAT ID ${buyer.tax_id}` : "No VAT ID"}</p>
      </> : <p className="t-meta">No buyer details available.</p>}
    </div>
  );
}
