"use client";

import Link from "next/link";
import { X, Info } from "lucide-react";
import { useToasts } from "@/lib/workspace-store";
import { StateIcon } from "./State";

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.tone === "info" ? <Info aria-hidden="true" /> : <StateIcon state={t.tone === "warn" ? "degraded" : t.tone} size={18} />}
          <div className="grow stack-sm" style={{ gap: 2 }}>
            <strong>{t.title}</strong>
            {t.body && <span className="t-meta">{t.body}</span>}
            {t.href && (
              <Link href={t.href} className="toast-link" onClick={() => dismiss(t.id)}>
                Open
              </Link>
            )}
          </div>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
