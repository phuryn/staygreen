import { ChevronDown } from "lucide-react";

/** A disclosure that says it opens: its label, then on the same line a chevron that turns while
 *  it is open (`design/README.md`, principle 9). */
export function Disclosure({ label, className, children }: { label: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <details className={className ? `disclosure ${className}` : "disclosure"}>
      <summary>
        {label}
        <ChevronDown className="disclosure-chev" aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}
