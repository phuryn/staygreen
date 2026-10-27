"use client";

import { TriangleAlert } from "lucide-react";

/** What a one-app choice leaves out, said on the screen itself. The choice must never make a
 *  screen look calmer than the workspace is: the row under the logo only counts the other apps
 *  that are degraded or down, and this says what needs the builder in them, with the way back
 *  (`docs/flows.md § Choosing an app`). */
export function OtherAppsNote({ children, onShowAll }: { children: React.ReactNode; onShowAll: () => void }) {
  return (
    <div className="callout callout-warn">
      <TriangleAlert aria-hidden="true" />
      <div className="cluster grow">
        <span>{children}</span>
        <button type="button" className="btn btn-sm" onClick={onShowAll}>Show all apps</button>
      </div>
    </div>
  );
}
