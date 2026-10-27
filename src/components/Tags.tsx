"use client";

import { Crown } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { offers, upgradeAction, type OfferKey } from "@/lib/upgrade";

/* The Builder mark (`design/README.md`, principle 8): one primitive for everything a Free
   workspace can see and not yet use.

   - Beside a field or an option, `<BuilderTag offer=… />` is a small cobalt "Builder" tag with the
     crown. Held, `locked={false}`, it is a quiet grey "Builder" that only says where it came from.
   - On a gated action, `<BuilderTag offer=… control="btn btn-primary">New status page</BuilderTag>`
     keeps the control's own class and label and puts the crown before the label.

   Pressed, either opens the same popover: what Builder adds there (`src/lib/upgrade.ts`) and one
   way to Builder, the billing page. Never nothing, never an error. It is cobalt because it can be
   pressed (principle 1): never amber, which means degraded. A control that can't open it directly,
   such as a switch, opens it by the tag's `id` with `showOffer`. Native `popover="auto"`, so
   Escape and a click outside close it, and nothing about it is modal. */

export function BuilderMark() {
  return <Crown className="builder-mark" aria-hidden="true" />;
}

type BuilderTagProps = {
  /** False when the workspace holds the feature: the tag only says where it came from. */
  locked?: boolean;
  /** What Builder adds here. The general list when the place has nothing more specific. */
  offer?: OfferKey;
  /** The popover's id, for a control beside the tag that opens it with `showOffer`. */
  id?: string;
  /** The class of the control this stands in for, which keeps its look; `children` is its label. */
  control?: string;
  children?: ReactNode;
  /** Opens the popover once rendered: a link that asked for the gated action lands here. */
  open?: boolean;
};

export function BuilderTag({ locked = true, offer = "builder", id, control, children, open = false }: BuilderTagProps) {
  const auto = useId();
  const popId = id ?? `builder-offer-${auto}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open || !locked) return;
    // A cached navigation may mount this during the click that closed the previous popover.
    // Open after that event and the route's layout work, not inside the old interaction.
    const frame = requestAnimationFrame(() => {
      if (!pop.current || pop.current.matches(":popover-open")) return;
      trigger.current?.scrollIntoView({ block: "center", behavior: "instant" });
      pop.current.showPopover();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, locked]);

  if (!locked) return <span className="tag">Builder</span>;
  const o = offers[offer];
  const cta = upgradeAction();

  return (
    <>
      {control ? (
        <button ref={trigger} type="button" className={`${control} builder-control`} popoverTarget={popId} aria-haspopup="dialog">
          <BuilderMark />
          {children}
          <span className="sr-only"> (Builder)</span>
        </button>
      ) : (
        <button ref={trigger} type="button" className="tag tag-builder" popoverTarget={popId} aria-haspopup="dialog">
          <BuilderMark />
          Builder
        </button>
      )}
      {/* Spans only: a tag can sit in a heading or a sentence, and a <div> or <p> there would be
          moved by the HTML parser, out of reach of the page that rendered it. */}
      <span
        ref={pop} id={popId} popover="auto" role="dialog" aria-labelledby={`${popId}-title`} className="pop builder-offer"
        onBeforeToggle={(e) => {
          if (e.newState === "open") place(e.currentTarget, trigger.current);
        }}
        onToggle={(e) => {
          if (e.newState !== "open") return;
          fit(e.currentTarget, trigger.current);
          e.currentTarget.querySelector<HTMLElement>(".builder-offer-go")?.focus();
        }}
      >
        <span className="tag tag-builder-static"><BuilderMark />Builder</span>
        <strong id={`${popId}-title`} className="builder-offer-title">{o.title}</strong>
        <span className="t-2">{o.body}</span>
        <span className="cluster">
          <Link href={cta.href} className="btn btn-primary btn-sm builder-offer-go">{cta.label}</Link>
          <button type="button" className="btn btn-sm" popoverTarget={popId} popoverTargetAction="hide">Not now</button>
        </span>
        {cta.note && <span className="hint">{cta.note}</span>}
      </span>
    </>
  );
}

/** Opens a Builder offer from a control beside its tag, such as a Builder-only switch. */
export function showOffer(id: string) {
  const el = document.getElementById(id);
  if (el && !el.matches(":popover-open")) el.showPopover();
}

const GUTTER = 16;

/** Under the control that opened it, inside the viewport's 16 px gutter. */
function place(el: HTMLElement, anchor: HTMLElement | null) {
  const box = (anchor ?? el).getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - GUTTER * 2);
  Object.assign(el.style, {
    left: `${Math.max(GUTTER, Math.min(box.left, window.innerWidth - width - GUTTER))}px`,
    top: `${box.bottom + 8}px`,
    width: `${width}px`,
  });
}

/** Above the control instead, when there is no room for it below. */
function fit(el: HTMLElement, anchor: HTMLElement | null) {
  const own = el.getBoundingClientRect();
  if (own.bottom <= window.innerHeight - GUTTER || !anchor) return;
  const box = anchor.getBoundingClientRect();
  el.style.top = `${Math.max(GUTTER, box.top - own.height - 8)}px`;
}

export function SoonTag() {
  return <span className="tag tag-soon">Coming soon</span>;
}
