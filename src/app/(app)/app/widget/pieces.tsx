// Kit previews of the widget's pieces. The pill takes the public headline, so a mixed
// checked/paused page never earns an all-clear. Runtime isolation lives in widget/client.ts.

import Link from "next/link";
import { X } from "lucide-react";
import type { State } from "@/lib/model";
import { StateIcon, publicWord } from "@/components/State";

/** The in-app banner: the state's word, a published or explicitly labelled example update,
 *  the way to the status page, and a dismiss button. */
export function BannerPreview({ state, text, href, onDismiss, example = false }: { state: "degraded" | "down"; text: string; href: string; onDismiss: () => void; example?: boolean }) {
  return (
    <div className={`sg-banner ${state}`} role="status" aria-live="polite">
      <StateIcon state={state} size={18} />
      <div className="sg-banner-body">
        <p>
          <span>{publicWord(state)}</span> {text}
        </p>
        <div className="sg-banner-meta">
          <span className="t-meta">{example ? "Example update" : "Published update"}</span>
          <Link href={href} className="sg-banner-link">See the status page</Link>
        </div>
      </div>
      <button type="button" className="sg-banner-x" aria-label="Dismiss this update" onClick={onDismiss}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

/** The footer pill. A paused page says paused: it isn't down, and nobody is checking that it's up. */
export function PillPreview({ state, title }: { state: State; title: string }) {
  return (
    <span className="sg-pill">
      <StateIcon state={state} size={14} />
      <span>{title}</span>
    </span>
  );
}
