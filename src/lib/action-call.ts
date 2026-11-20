/* Calling a Server Action from the browser, when the edge may refuse it.

   Netlify's flood limit (`netlify/edge-functions/`) answers a
   `429` before the action runs, so the client never gets the `{ error }` an
   action would have returned — it gets a rejected promise, and Next tells it
   nothing useful about why ("an unexpected response"). Every place that awaits
   an action goes through `attempt`, which turns that rejection into the same
   shape the components already know how to show. Generic and honest about it:
   the browser cannot read the status, so the message does not claim one.

   No `server-only`: this runs on the phone. */

export const UNREACHABLE = "Couldn’t confirm that change. Wait a minute, then retry the same action.";
let active = 0;
export function actionsInFlight(): boolean { return active > 0; }

export async function attempt<T>(call: () => Promise<T>): Promise<T | { error: string }> {
  try {
    active += 1;
    return await call();
  } catch {
    return { error: UNREACHABLE };
  } finally {
    active -= 1;
  }
}
