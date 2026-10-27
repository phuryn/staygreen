import "server-only";
import { headers } from "next/headers";
import { isSameOrigin } from "./origin";

/* Reading the request, in one place. */

export class CrossOrigin extends Error {
  constructor() {
    super("Cross-origin request refused");
    this.name = "CrossOrigin";
  }
}

/** `§ 1.2`: the Origin check on every mutation. Next already refuses a Server
 *  Action whose Origin does not match the Host; this is the same rule written
 *  where it can be read and tested, and where Phase 3's API can reuse it. */
export async function assertSameOrigin(): Promise<void> {
  const h = await headers();
  const ok = isSameOrigin({
    secFetchSite: h.get("sec-fetch-site"),
    origin: h.get("origin"),
    host: h.get("x-forwarded-host") ?? h.get("host"),
  });
  if (!ok) throw new CrossOrigin();
}
