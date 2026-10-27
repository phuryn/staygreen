// The logo: the green mark and the name, the same on the site and in the app shell. It is never
// a status light (owner, 2026-10-22, `docs/product/decisions.md`): a mark that turns grey or red
// stops reading as the logo, and a state already has its own shape, word and colour wherever one
// is shown (`State.tsx`), the app row under this logo included.

export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" style={{ flex: "none" }}>
      <circle cx="10" cy="10" r="9" fill="none" stroke="var(--up)" strokeWidth="2" opacity="0.35" />
      <circle cx="10" cy="10" r="5.5" fill="var(--up)" />
    </svg>
  );
}

export function Logo({ size = 18, word = true }: { size?: number; word?: boolean }) {
  return (
    <span className="logo">
      <Mark size={size} />
      {word && <span className="logo-word">Staygreen</span>}
    </span>
  );
}
