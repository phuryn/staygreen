"use client";

import { useState } from "react";

/* The one button on a page an email's link opens (stop alerts, confirm an address). The link
   itself never acts, because mail scanners open links; pressing this does, once, and the page
   says what happened in the button's place. */

export type LinkActionResult = { ok: boolean; title: string; text: string };

export function LinkAction({ action, label }: { action: () => Promise<LinkActionResult>; label: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkActionResult | null>(null);
  if (result) {
    return (
      <div className={`callout ${result.ok ? "callout-up" : "callout-warn"}`} role="status">
        <span className="stack-sm">
          <strong>{result.title}</strong>
          <span>{result.text}</span>
        </span>
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setResult(await action());
          } catch {
            setResult({ ok: false, title: "Not done", text: "Something went wrong before Staygreen answered. Try the link again in a moment." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </button>
    </div>
  );
}
