/* The Origin check on every mutation (`AGENTS.md § 1.2`). Pure, so the unit
   suite holds it; `request.ts` reads the headers.

   Fetch metadata first: a browser that sends `Sec-Fetch-Site` has told us where
   the request came from, and only `same-origin` passes. A client that sends no
   fetch metadata falls back to comparing `Origin` with the host it reached. A
   request with neither is refused: every browser we serve sends one of them. */

export type OriginHeaders = {
  secFetchSite: string | null;
  origin: string | null;
  host: string | null;
};

export function isSameOrigin({ secFetchSite, origin, host }: OriginHeaders): boolean {
  if (secFetchSite) return secFetchSite === "same-origin";
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
