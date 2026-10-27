"use client";

// Small UI helpers shared by the dashboard screens: a native <dialog>
// driven by an `open` prop, and accessible tabs. Kit classes only (dialog, tabs).

import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

const TitleId = createContext<string | undefined>(undefined);

export function Modal({ open, onClose, children, wide, undismissable = false }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean; undismissable?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " pb-dialog-wide" : ""}`}
      aria-labelledby={id}
      onClose={() => { if (!undismissable) onClose(); }}
      onCancel={(e) => { if (undismissable) e.preventDefault(); }}
      onClick={(e) => {
        if (!undismissable && e.target === e.currentTarget) onClose();
      }}
    >
      {open && <TitleId.Provider value={id}>{children}</TitleId.Provider>}
    </dialog>
  );
}

export function ModalBody({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const id = useContext(TitleId);
  return (
    <div className="dialog-body">
      <h2 id={id} className="t-section">{title}</h2>
      {children}
    </div>
  );
}

export function ModalFoot({ children }: { children: ReactNode }) {
  return <div className="dialog-foot">{children}</div>;
}

export type Tab = { id: string; label: ReactNode; body: ReactNode };

export function Tabs({ tabs, label, initial }: { tabs: Tab[]; label: string; initial?: string }) {
  const [cur, setCur] = useState(initial ?? tabs[0]?.id);
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === cur);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next].id;
    setCur(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${t.id}-tab`}
            aria-controls={`${base}-${t.id}`}
            aria-selected={cur === t.id}
            tabIndex={cur === t.id ? 0 : -1}
            onClick={() => setCur(t.id)}
            onKeyDown={onKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`${base}-${t.id}`} aria-labelledby={`${base}-${t.id}-tab`} hidden={cur !== t.id} tabIndex={0} className="pb-tabpanel">
          {t.body}
        </div>
      ))}
    </div>
  );
}

export function randomCode(n: number) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < n; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}
