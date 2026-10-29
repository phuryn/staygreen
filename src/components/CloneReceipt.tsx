"use client";

import Link from "next/link";
import { cloneSkipReason, nameList } from "@/lib/demo-clone";
import { useCloneReceipt } from "@/lib/workspace-store";

/** A receipt kept in this workspace's browser session, below the suggestions page's head.
 * It does not expire like a toast: every omitted check remains available to read. It names every
 * monitor the copy made, so it matches Overview: the copied checks, then any the address brought. */
export function CloneReceipt({ appId }: { appId: string }) {
  const receipt = useCloneReceipt(appId);
  if (!receipt) return null;
  return <section className="callout callout-info" aria-label="Clone result"><div className="stack-sm">
    <p>Your status page is members-only. <Link className="link" href={`/app/status-pages/${receipt.pageId}`}>Open the editor to publish it</Link>.</p>
    <p>{receipt.copied.length ? `Copied ${nameList(receipt.copied)}.` : "No checks were copied."}
      {receipt.added.length > 0 && ` Staygreen also added ${nameList(receipt.added)}, the certificate ${receipt.added.length === 1 ? "check" : "checks"} every HTTPS address gets.`}
      {receipt.copied.length + receipt.added.length > 0 && " They're listed under Already covered below."}</p>
    {receipt.skipped.length > 0 && <><p>Checks not copied:</p><ul className="stack-sm">{receipt.skipped.map((m, i) =>
      <li key={i}>{m.name}: {cloneSkipReason[m.reason]}</li>)}</ul></>}
  </div></section>;
}
