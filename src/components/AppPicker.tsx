"use client";

import { useEffect, useId, useRef, useState, type AriaAttributes, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { App } from "@/lib/model";
import { AppLogo } from "./AppLogo";

type Props = Pick<AriaAttributes, "aria-labelledby" | "aria-describedby"> & {
  id: string;
  apps: readonly Pick<App, "id" | "name" | "logoUrl">[];
  value: string;
  onChange: (value: string) => void;
  allApps?: boolean;
  disabled?: boolean;
  emptyMessage?: string;
};

/** A form/filter choice, unlike the rail's navigation menu. Uses the same native top layer
 *  and measured anchor as AppSwitcher; focus moves without committing until Enter or a click. */
export function AppPicker({ id, apps, value, onChange, allApps = false, disabled = false,
  emptyMessage = "No apps available", "aria-labelledby": labelledBy, "aria-describedby": describedBy }: Props) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef<DOMRect | null>(null);
  const [open, setOpen] = useState(false);
  const options = [
    ...(allApps ? [{ id: "all", name: "All apps", app: null }] : []),
    ...apps.map((app) => ({ id: app.id, name: app.name, app })),
  ];
  const selected = options.findIndex((option) => option.id === value);
  const chosen = options[selected];
  const label = chosen?.name ?? (options.length ? "Choose an app" : emptyMessage);
  const unavailable = disabled || options.length === 0;
  const items = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
  const focus = (index: number) => {
    const item = items()[index];
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest" });
  };
  function close() {
    list.current?.hidePopover();
    trigger.current?.focus();
  }
  function openAt(index: number) {
    if (unavailable) return;
    list.current?.showPopover();
    // Native toggle events are queued. Focus now, so a quick Tab cannot leave the trigger
    // before a later toggle handler pulls focus back into the list.
    focus(index);
  }
  function choose(index: number) {
    if (unavailable || !options[index]) return;
    close();
    // Confirming the app already shown is not a change: a caller that resets its form on
    // change (alert routing) must not lose unsaved edits to a closed list.
    if (options[index].id !== value) onChange(options[index].id);
  }
  function nextIndex(key: string, index: number): number | undefined {
    if (key === "ArrowDown") return Math.min(index + 1, options.length - 1);
    if (key === "ArrowUp") return Math.max(index - 1, 0);
    if (key === "Home") return 0;
    if (key === "End") return options.length - 1;
    if (key.length === 1 && key !== " ") {
      // Repeating a letter cycles through every app starting with it, including the current one.
      for (let step = 1; step <= options.length; step++) {
        const next = (index + step + options.length) % options.length;
        if (options[next].name.trim().toLocaleLowerCase().startsWith(key.toLocaleLowerCase())) return next;
      }
    }
  }
  function onKey(event: KeyboardEvent, inList: boolean) {
    if (unavailable || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const index = inList ? items().indexOf(document.activeElement as HTMLButtonElement) : selected;
    if (inList && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      choose(index);
    } else if (inList && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (inList && event.key === "Tab") {
      // Return to the trigger before the browser takes its normal next/previous tab stop.
      close();
    } else {
      const next = nextIndex(event.key, index);
      if (next === undefined) return;
      event.preventDefault();
      if (inList) focus(next);
      else openAt(next);
    }
  }

  useEffect(() => {
    const closeOnMove = (event: Event) => {
      // Scrolling a long list must keep it open; only a moving anchor invalidates placement.
      if (event.target instanceof Node && list.current?.contains(event.target)) return;
      const box = trigger.current?.getBoundingClientRect();
      const was = anchor.current;
      if (event.type === "scroll" && box && was && box.left === was.left && box.bottom === was.bottom && box.width === was.width) return;
      list.current?.hidePopover();
    };
    window.addEventListener("resize", closeOnMove);
    document.addEventListener("scroll", closeOnMove, true);
    return () => {
      window.removeEventListener("resize", closeOnMove);
      document.removeEventListener("scroll", closeOnMove, true);
    };
  }, []);
  useEffect(() => { if (unavailable) list.current?.hidePopover(); }, [unavailable]);

  return (
    <div className="app-picker">
      <button
        ref={trigger} id={id} type="button" className="select app-picker-trigger" disabled={unavailable}
        popoverTarget={listId} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-labelledby={labelledBy} aria-describedby={[`${listId}-value`, describedBy].filter(Boolean).join(" ")}
        onKeyDown={(event) => onKey(event, false)}
        onClick={(event) => {
          // Keep the native invoker relationship, but focus synchronously after showing it.
          event.preventDefault();
          if (list.current?.matches(":popover-open")) close();
          else openAt(Math.max(selected, 0));
        }}
      >
        {chosen?.app && <AppLogo app={chosen.app} size={20} />}
        <span id={`${listId}-value`} className="app-picker-name" title={label}>{label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <div
        ref={list} id={listId} popover="auto" role="listbox" className="pop app-picker-list"
        aria-labelledby={labelledBy ?? id} onKeyDown={(event) => onKey(event, true)}
        onBlur={(event) => {
          // Tab and a programmatic focus move should dismiss too; focus within the list stays.
          // The trigger handles its own toggle: dismissing on its pointerdown focus would
          // make the following click see a closed list and reopen it instead of closing it.
          if (event.relatedTarget === trigger.current) return;
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.hidePopover();
        }}
        onBeforeToggle={(event) => {
          if (event.newState !== "open" || !trigger.current) return;
          if (unavailable) { event.preventDefault(); return; }
          const box = trigger.current.getBoundingClientRect();
          anchor.current = box;
          const below = window.innerHeight - box.bottom;
          const above = box.top > below;
          Object.assign(event.currentTarget.style, {
            left: `${box.left}px`, width: `${box.width}px`,
            top: above ? "auto" : `${box.bottom}px`,
            bottom: above ? `${window.innerHeight - box.top}px` : "auto",
            maxHeight: `calc(${above ? box.top : below}px - var(--s-3))`,
          });
        }}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        {options.map((option, index) => (
          <button
            key={option.id} type="button" role="option" aria-selected={option.id === value}
            tabIndex={-1} className="app-picker-option" title={option.name} onClick={() => choose(index)}
          >
            {option.app && <AppLogo app={option.app} size={20} />}
            <span className="app-picker-name">{option.name}</span>
            {option.id === value && <Check aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
}
