import { vi } from "vitest";

/** Database boundary only: callers still execute the real auth/tool/action logic. */
export function agentQuery(data: unknown, error: unknown = null) {
  const q: Record<string, unknown> = {};
  for (const name of ["select", "eq", "is", "not", "in", "gte", "gt", "or", "order", "limit", "update", "insert", "single", "maybeSingle"]) {
    q[name] = vi.fn(() => q);
  }
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve);
  return q;
}
