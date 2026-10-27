"use server";

import { unsubscribeByToken } from "@/lib/alerts/public";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import type { LinkActionResult } from "@/components/alerts/LinkAction";

/* The unsubscribe page's button (`src/lib/alerts/public.ts`). The token is the authority; the
   Origin check keeps another site from pressing it for a visitor who has the page open. */
export async function unsubscribeAlerts(token: string): Promise<LinkActionResult> {
  try {
    await assertSameOrigin();
  } catch (e) {
    if (e instanceof CrossOrigin) return { ok: false, title: "Not done", text: "This request didn't come from Staygreen, so it was refused." };
    throw e;
  }
  const { outcome, members } = await unsubscribeByToken(String(token));
  switch (outcome) {
    case "unsubscribed":
      return members
        ? { ok: true, title: "You won't get these alerts by email any more", text: "Other members still do. You can turn yours back on from the Alerts page in Staygreen." }
        : { ok: true, title: "This address gets no more of these alerts", text: "To get them again, ask the workspace to add the address once more." };
    case "already":
      return { ok: true, title: "These alerts had already stopped", text: "Nothing more is sent here." };
    case "gone":
      return { ok: true, title: "These alerts had already stopped", text: "The channel that sent them was removed." };
    case "unavailable":
      return { ok: false, title: "Not done", text: "Unsubscribing isn't set up on this server." };
    default:
      return { ok: false, title: "Not done", text: "This link isn't one Staygreen made, or part of it is missing. Nothing was changed." };
  }
}
