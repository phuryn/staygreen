"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

export type SectionToggle = { expanded: boolean; onToggle: () => void };

/** A panel whose heading and toggle stay together. Hidden children stay mounted so collapsing
 *  a form never discards its draft, an upload result or a domain check in progress. */
export function CollapsibleSection({ id, title, expanded, onToggle, actions, children }: SectionToggle & {
  id: string; title: string; actions?: ReactNode; children: ReactNode;
}) {
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <section className="panel panel-collapsible" aria-labelledby={id}>
      <div className="panel-head">
        <div className="cluster">
          <h2 id={id} className="t-section">{title}</h2>
          <button type="button" className="btn btn-sm btn-quiet btn-icon" aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`}
            aria-expanded={expanded} aria-controls={`${id}-content`} onClick={onToggle}>
            <Chevron aria-hidden="true" />
          </button>
        </div>
        {expanded && actions}
      </div>
      <div id={`${id}-content`} hidden={!expanded}>{children}</div>
    </section>
  );
}
