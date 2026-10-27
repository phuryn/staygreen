"use client";

import type { Ref } from "react";
import { DeleteDialog } from "@/components/DeleteDialog";
import { pageHost } from "@/lib/derive";
import { useActs, type Workspace } from "@/lib/workspace-store";

/** An app takes its monitors and its status page with it, so deleting one needs both rights. */
export const canDeleteApps = (s: Workspace) => !!(s.can["monitors:delete"] && s.can["pages:manage"]);

/** The one confirmation for deleting an app, from Settings or the overview: what goes with it. */
export function DeleteAppDialog({ ref, s, appId }: { ref: Ref<HTMLDialogElement>; s: Workspace; appId: string | null }) {
  const acts = useActs();
  const app = s.apps.find((a) => a.id === appId);
  const monitors = s.monitors.filter((m) => m.appId === appId).length;
  const page = s.pages.find((p) => p.appId === appId);
  return (
    <DeleteDialog ref={ref} title={`Delete ${app?.name ?? "this app"}?`} confirm="Delete app" run={() => acts.deleteApp(appId ?? "")}>
      <p>
        {monitors === 1 && <>Its monitor is deleted, with its incidents. </>}
        {monitors > 1 && <>Its {monitors} monitors are deleted, with their incidents. </>}
        {page ? <>Its status page at <span className="addr">{pageHost(page)}</span> stops answering. </> : null}
        This can&apos;t be undone.
      </p>
    </DeleteDialog>
  );
}
