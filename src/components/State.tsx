import type { State } from "@/lib/model";

// State is shape, word and colour (design/README.md § Principles). Shapes stay distinct for
// colour-blind readers and in forced-colours mode.

export function StateIcon({ state, size = 14, title }: { state: State; size?: number; title?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", className: `state-icon ${state}`, "aria-hidden": title ? undefined : true, role: title ? "img" : undefined } as const;
  // Healthy is quiet: below 18px, up is a plain dot. A problem keeps its full shape.
  if (state === "up" && size < 18)
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <circle cx="8" cy="8" r="4.5" fill="currentColor" />
      </svg>
    );
  if (state === "up")
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <circle cx="8" cy="8" r="7.5" fill="currentColor" />
        <path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="var(--surface)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "degraded")
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <path d="M8 1.2 15.2 14.3H.8z" fill="currentColor" strokeLinejoin="round" />
        <path d="M8 6v3.8" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="12" r="1" fill="var(--surface)" />
      </svg>
    );
  if (state === "down")
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <rect x="1" y="1" width="14" height="14" rx="2.5" fill="currentColor" />
        <path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="var(--surface)" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
    );
  // Not checked yet: an empty ring, because nothing has filled it in.
  if (state === "unchecked")
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  return (
    <svg {...common}>
      {title && <title>{title}</title>}
      <circle cx="8" cy="8" r="7.5" fill="currentColor" />
      <path d="M6.2 5v6M9.8 5v6" stroke="var(--surface)" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

const words: Record<State, string> = { up: "Up", degraded: "Degraded", down: "Down", paused: "Paused", unchecked: "Not checked yet" };
const publicWords: Record<State, string> = { up: "Operational", degraded: "Degraded", down: "Outage", paused: "Paused", unchecked: "Not checked yet" };

export function StateBadge({ state, publicFacing, label, size }: { state: State; publicFacing?: boolean; label?: string; size?: number }) {
  return (
    <span className={`state ${state}`}>
      <StateIcon state={state} size={size} />
      <span>{label ?? (publicFacing ? publicWords[state] : words[state])}</span>
    </span>
  );
}

export const stateWord = (s: State) => words[s];
export const publicWord = (s: State) => publicWords[s];
