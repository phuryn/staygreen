import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** False during the server render and hydration, true after. Anything that depends on the
 *  browser (its time zone, above all) waits for it, so the server's HTML and the first client
 *  render always agree. */
export const useMounted = () => useSyncExternalStore(noop, () => true, () => false);
