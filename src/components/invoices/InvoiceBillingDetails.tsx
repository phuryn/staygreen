"use client";

import { useId, useState, useTransition } from "react";
import { BadgeCheck, CircleX, Clock, Info } from "lucide-react";
import { saveInvoiceBillingDetails, type BillingState } from "@/app/invoice-page-actions";
import { attempt } from "@/lib/action-call";
import type { BillingDetails, BillingResponse } from "@/lib/invoices/contract";
import { BILLING_COUNTRIES } from "@/lib/invoices/countries";
import { buyerAddress, buyerTaxId } from "@/lib/invoices/page-model";
import { ProfileSection } from "../ui";

const names = new Intl.DisplayNames(["en"], { type: "region" });
const countries = BILLING_COUNTRIES.map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
const checkLooks = {
  valid: { icon: BadgeCheck, tone: "up" }, invalid: { icon: CircleX, tone: "down" },
  unavailable: { icon: Clock, tone: "warn" }, not_applicable: { icon: Info, tone: "info" },
} as const;
// The field is named `vies`, but contract 1.1.4 has the service check a billing country of PL in the Ministry of
// Finance's VAT White List, where `valid` means an active or exempt VAT payer, and every other EU country in VIES.
const checkMessages = {
  vies: {
    valid: "VAT ID confirmed in VIES.", invalid: "VIES did not confirm this VAT ID.",
    unavailable: "VIES was unavailable. The VAT ID could not be checked.", not_applicable: "VIES does not apply to these details.",
  },
  whiteList: {
    valid: "The Ministry of Finance's VAT White List lists this NIP as an active or exempt VAT payer.",
    invalid: "The Ministry of Finance's VAT White List does not list this NIP as an active or exempt VAT payer.",
    unavailable: "The Ministry of Finance's VAT White List was unavailable. The NIP could not be checked.",
    not_applicable: "No VAT ID check applies to these details.",
  },
};

export function ViesMessage({ vies, country }: { vies: BillingResponse["vies"]; country: string | undefined }) {
  if (!vies) return null;
  const { icon: Icon, tone } = checkLooks[vies.status];
  const text = checkMessages[country === "PL" ? "whiteList" : "vies"][vies.status];
  return <p className={`callout callout-${tone}`}><Icon aria-hidden="true" /><span>{text}</span></p>;
}

export function billingDraft(billing: BillingResponse, organization: string) {
  const details: BillingDetails = billing.details ?? {
    type: "company", name: "", tax_id: null, address_line1: "", address_line2: null, postal_code: "", city: "", country: "",
  };
  return { details, version: billing.version, organization };
}

type Props = {
  billing: BillingResponse; organization: string; canManage: boolean; editing: boolean;
  onEditing: (editing: boolean) => void; onSaved: (billing: BillingResponse) => void; onReload: () => Promise<void>;
};

export function InvoiceBillingDetails({ billing, organization, canManage, editing, onEditing, onSaved, onReload }: Props) {
  const [saved, setSaved] = useState(false);
  const details = billing.details;
  return (
    <ProfileSection title="Billing details">
      {editing && canManage
        ? <BillingForm billing={billing} organization={organization} onCancel={() => onEditing(false)} onReload={onReload}
            onSaved={next => { setSaved(true); onSaved(next); }} />
        : <>
            {details ? (
              <dl className="kv wrap-anywhere">
                <dt>Invoices go to</dt><dd>{details.name}</dd>
                <dt>Buyer type</dt><dd>{details.type === "company" ? "Company" : "Individual"}</dd>
                <dt>Address</dt><dd>{buyerAddress(details)}</dd>
                {details.type === "company" && <><dt>VAT ID</dt><dd>{details.tax_id ?? "None"}</dd></>}
              </dl>
            ) : <p className="t-2">No billing details saved yet.</p>}
            {details?.type !== "person" && <ViesMessage vies={billing.vies} country={details?.country} />}
            {saved && <p className="t-2" role="status">Billing details saved.</p>}
            <p className="t-meta">Saved details apply to future invoices. Use Correct on an eligible invoice to update its buyer.</p>
            {canManage && <div><button type="button" className="btn" onClick={() => { setSaved(false); onEditing(true); }}>{details ? "Edit billing details" : "Add billing details"}</button></div>}
          </>}
    </ProfileSection>
  );
}

function BillingForm({ billing, organization, onCancel, onSaved, onReload }: {
  billing: BillingResponse; organization: string; onCancel: () => void; onSaved: (billing: BillingResponse) => void; onReload: () => Promise<void>;
}) {
  // A refresh can change the saved details, but this draft must retain the
  // version and workspace it was read from until editing ends.
  const [draft, setDraft] = useState(() => billingDraft(billing, organization));
  const [result, setResult] = useState<BillingState>({});
  const [busy, start] = useTransition();
  const formId = useId();
  const conflict = result.code === "version_conflict";
  const workspaceChanged = result.code === "organization_changed";
  const change = (key: keyof BillingDetails, value: string | null) => {
    setDraft(current => ({ ...current, details: { ...current.details, [key]: value } }));
    if (!conflict && !workspaceChanged) setResult({});
  };
  function field(label: string, key: keyof BillingDetails, maxLength: number, autoComplete: string, required = true, hint?: string) {
    const error = result.fields?.[key];
    const id = `${formId}-${key}`;
    return (
      <div className="field">
        <label className="label" htmlFor={id}>{label}</label>
        <input className="input" id={id} autoComplete={autoComplete} value={draft.details[key] ?? ""} maxLength={maxLength} required={required}
          aria-invalid={!!error} aria-describedby={error || hint ? `${id}-hint` : undefined}
          onChange={event => change(key, event.target.value || (required ? "" : null))} />
        {(error || hint) && <span id={`${id}-hint`} className={error ? "error" : "hint"}>{error || hint}</span>}
      </div>
    );
  }
  return (
    <form onSubmit={event => {
      event.preventDefault();
      if (busy || conflict || workspaceChanged) return;
      start(async () => {
        // The draft keeps a VAT ID typed before switching to Individual, so switching back restores it; none is sent.
        const next: BillingState = await attempt(() => saveInvoiceBillingDetails({ ...draft, details: { ...draft.details, tax_id: buyerTaxId(draft.details) } }));
        setResult(next);
        if (next.saved && next.billing) onSaved(next.billing);
      });
    }}>
      <fieldset className="stack" disabled={busy}>
        <div className="field">
          <label className="label" htmlFor={`${formId}-type`}>Buyer type</label>
          <select className="select" id={`${formId}-type`} value={draft.details.type} onChange={event => change("type", event.target.value)}
            aria-describedby={draft.details.type === "person" ? `${formId}-type-hint` : undefined}>
            <option value="company">Company</option><option value="person">Individual</option>
          </select>
          {draft.details.type === "person" && <span id={`${formId}-type-hint`} className="hint">An individual is invoiced as a consumer, without a VAT ID. Buying for a business, a sole proprietorship included? Choose Company.</span>}
        </div>
        {field(draft.details.type === "company" ? "Company name" : "Full name", "name", 200, draft.details.type === "company" ? "organization" : "name")}
        {draft.details.type === "company" && field("VAT ID (optional)", "tax_id", 32, "off", false, "EU VAT IDs are checked when you save: a Polish NIP in the Ministry of Finance's VAT White List, any other in VIES.")}
        {field("Address", "address_line1", 200, "address-line1")}
        {field("Address line 2 (optional)", "address_line2", 200, "address-line2", false)}
        <div className="field-columns">
          {field("Postal code", "postal_code", 20, "postal-code")}
          {field("City", "city", 100, "address-level2")}
        </div>
        <div className="field">
          <label className="label" htmlFor={`${formId}-country`}>Country</label>
          <select className="select" id={`${formId}-country`} value={draft.details.country} autoComplete="country" required
            aria-invalid={!!result.fields?.country} aria-describedby={result.fields?.country ? `${formId}-country-error` : undefined}
            onChange={event => change("country", event.target.value)}>
            <option value="">Choose a country</option>
            {countries.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
          </select>
          {result.fields?.country && <span id={`${formId}-country-error`} className="error">{result.fields.country}</span>}
        </div>
        {result.error && <p className="error" role="alert">{result.error}</p>}
        <div className="cluster">
          {conflict ? <button className="btn" type="button" onClick={() => start(onReload)}>Reload billing details</button>
            : <button className="btn btn-primary" type="submit" disabled={workspaceChanged}>{busy ? "Saving…" : "Save details"}</button>}
          <button className="btn" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </fieldset>
    </form>
  );
}
