"use server";

import { confirmByToken } from "@/lib/alerts/public";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import type { LinkActionResult } from "@/components/alerts/LinkAction";

/* The confirmation page's button (`src/lib/alerts/public.ts`): the address starts getting the
   workspace's alerts only now, once its owner said so. */
export async function confirmAlerts(token: string): Promise<LinkActionResult> {
  try {
    await assertSameOrigin();
  } catch (e) {
    if (e instanceof CrossOrigin) return { ok: false, title: "Not done", text: "This request didn't come from Staygreen, so it was refused." };
    throw e;
  }
  switch (await confirmByToken(String(token))) {
    case "confirmed":
      return { ok: true, title: "Confirmed", text: "This address now gets the workspace's alerts. Every alert has a link to stop them." };
    case "expired":
      return { ok: false, title: "This link has expired", text: "Ask whoever added the address to send a new one from Staygreen." };
    default:
      return { ok: false, title: "This link doesn't work", text: "It was already used, or it isn't one Staygreen made." };
  }
}
