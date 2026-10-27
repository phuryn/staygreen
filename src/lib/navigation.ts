/* Moving between dashboard screens (`docs/architecture.md § Feeds and polling`): the two choices
   the browser makes on its own, kept pure so they are tested without a browser. */

/** The snapshot a screen shows: the newer of its page's own and the newest any page has handed up.
 *  They differ when the router shows a page it kept from a visit in the last 30 seconds, which
 *  carries the copy it was rendered with; the screen then shows what the last page brought. */
export function newerSnapshot<T extends { loadedAt: number }>(page: T | null, latest: T | null): T | null {
  if (!page || !latest) return page ?? latest;
  return latest.loadedAt > page.loadedAt ? latest : page;
}

export type LinkClick = {
  /** `MouseEvent.button`: 0 is the main button. */
  button: number;
  /** Any of Ctrl, Meta, Shift or Alt held, which opens the link elsewhere or downloads it. */
  modified: boolean;
  /** The anchor's resolved `href`. */
  href: string;
  /** The anchor's `target`, empty when it has none. */
  target: string;
  download: boolean;
};

/** The dashboard path a click on a link is taking the builder to, or null when the click waits on
 *  no dashboard screen: another button or a modifier, a new tab or a download, another origin, a
 *  page outside `/app`, or the screen already shown. */
export function pendingPathOf(click: LinkClick, here: { origin: string; pathname: string }): string | null {
  if (click.button !== 0 || click.modified || click.download) return null;
  if (click.target && click.target !== "_self") return null;
  let to: URL;
  try {
    to = new URL(click.href, here.origin);
  } catch {
    return null;
  }
  const inDashboard = to.pathname === "/app" || to.pathname.startsWith("/app/");
  if (to.origin !== here.origin || !inDashboard || to.pathname === here.pathname) return null;
  return to.pathname;
}
