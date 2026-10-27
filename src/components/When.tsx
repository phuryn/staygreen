"use client";

import { dayTime, zone } from "@/lib/format";
import { useMounted } from "@/lib/use-mounted";

/** "22 Oct 14:05 UTC": what the server can say without knowing the visitor's zone. */
export const utcDayTime = (t: number) => {
  const d = new Date(t);
  const mon = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${mon}, ${d.toISOString().slice(11, 16)} UTC`;
};

/** A moment on a page the server renders: UTC in the HTML, the visitor's own zone once the
 *  page runs in their browser. Public pages are read by people anywhere. */
export function When({ t, now }: { t: number; now: number }) {
  const mounted = useMounted();
  return <time dateTime={new Date(t).toISOString()}>{mounted ? `${dayTime(t, now)} ${zone(t)}` : utcDayTime(t)}</time>;
}
