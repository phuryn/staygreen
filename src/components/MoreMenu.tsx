"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type MoreItem = { label: string; icon: ReactNode; onSelect: () => void };

/** A quiet "…" button and its short menu, for what should take two clicks to reach: deleting an
 *  app is never one click away (owner, 2026-10-26). The kit's native popover at the button's right
 *  edge, under it or, with no room there, above it; closed by a scroll that moves the button,
 *  which would leave it behind. */
export function MoreMenu({ label, items }: { label: string; items: MoreItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchor = useRef<DOMRect | null>(null);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      const box = trigger.current?.getBoundingClientRect();
      const was = anchor.current;
      if (event.type === "scroll" && box && was && box.left === was.left && box.top === was.top) return;
      if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, []);

  const options = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const all = options();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[(at + (event.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    } else if (event.key === "Tab") {
      menu.current?.hidePopover();
      trigger.current?.focus();
    }
  }

  return (
    <>
      <button ref={trigger} type="button" className="btn btn-sm btn-quiet btn-icon" popoverTarget={id} aria-haspopup="menu" aria-label={label}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      <div
        ref={menu} id={id} popover="auto" role="menu" aria-label={label} className="pop more-menu"
        onKeyDown={onKey}
        onBeforeToggle={(event) => {
          if (event.newState !== "open" || !trigger.current) return;
          const box = trigger.current.getBoundingClientRect();
          anchor.current = box;
          const { clientWidth, clientHeight } = document.documentElement;
          // An item is at most a touch target tall; without room for all of them below, it opens above.
          const room = clientHeight - box.bottom;
          const up = room < items.length * 44 + 16 && box.top > room;
          Object.assign(event.currentTarget.style, {
            top: up ? "auto" : `${box.bottom + 4}px`, bottom: up ? `${clientHeight - box.top + 4}px` : "auto", right: `${clientWidth - box.right}px`,
          });
        }}
        onToggle={(event) => {
          // Focusing must not scroll the page, which would move the button away from its menu.
          if (event.newState === "open") options()[0]?.focus({ preventScroll: true });
        }}
      >
        {items.map((item) => (
          <button
            key={item.label} type="button" role="menuitem" tabIndex={-1} className="menu-item"
            onClick={() => {
              menu.current?.hidePopover();
              // Back on the button first, so a dialog the item opens returns focus there.
              trigger.current?.focus();
              item.onSelect();
            }}
          >
            {item.icon}{item.label}
          </button>
        ))}
      </div>
    </>
  );
}
