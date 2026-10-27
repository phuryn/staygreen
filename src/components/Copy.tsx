"use client";

import { Check, Copy as CopyIcon } from "lucide-react";
import { useState } from "react";

/** `icon` shows the glyph alone, as a quiet icon button named by `label` (`design/README.md § Buttons`). */
export function Copy({ text, label = "Copy", done = "Copied", className = "btn btn-sm", icon = false }: { text: string; label?: string; done?: string; className?: string; icon?: boolean }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={icon ? `${className} btn-quiet btn-icon` : className}
      aria-label={icon ? (ok ? done : label) : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1600);
        } catch {
          setOk(false);
        }
      }}
    >
      {ok ? <Check aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {icon ? <span className="sr-only" aria-live="polite">{ok ? done : ""}</span> : <span aria-live="polite">{ok ? done : label}</span>}
    </button>
  );
}
