import { notFound } from "next/navigation";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type Caller } from "@/lib/authz";
import { FREE } from "@/lib/plans";
import { allowed, requireIn, type Member } from "@/lib/workspace";

/* The resolve-then-check helper a dashboard page runs (`AGENTS.md § 1.1`):
   the row is resolved from the URL, then the caller is checked against the
   workspace that owns it. Missing, foreign and forbidden are the same 404.
   `requireIn` and `allowed` read no database and no Clerk, so nothing is mocked. */

const A = { id: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", clerk_org_id: "org_A" };
const B = { id: "ws_bbbbbbbbbbbbbbbbbbbbbbbb", clerk_org_id: "org_B" };

const adminOfA: Caller = { userId: "user_1", orgId: "org_A", orgRole: "org:admin" };
const member = (caller: Caller): Member => ({ caller, workspace: { id: A.id, clerk_org_id: caller.orgId ?? "" }, entitlements: FREE });

const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return e as Error & { digest?: string };
  }
  throw new Error("expected a throw");
};

/** What Next's own `notFound()` throws, so the 404 is recognised without copying its digest. */
const NOT_FOUND = thrown(() => notFound()).digest;

describe("requireIn", () => {
  const ownedByA = { id: "mon_aaaaaaaaaaaaaaaaaaaaaaaa", workspace: A };
  const ownedByB = { id: "mon_bbbbbbbbbbbbbbbbbbbbbbbb", workspace: B };

  it("returns the resolved row to this workspace's admin", () => {
    expect(requireIn(ownedByA, member(adminOfA), "monitors:delete")).toBe(ownedByA);
  });

  it("answers a missing row with a 404", () => {
    expect(thrown(() => requireIn(null, member(adminOfA), "monitors:read")).digest).toBe(NOT_FOUND);
  });

  it.each(PERMISSIONS)("answers another workspace's row with the same 404, for %s", (permission) => {
    expect(thrown(() => requireIn(ownedByB, member(adminOfA), permission)).digest).toBe(NOT_FOUND);
  });

  it("answers a member whose role holds nothing with the same 404", () => {
    const plain: Caller = { userId: "user_2", orgId: "org_A", orgRole: "org:member" };
    expect(thrown(() => requireIn(ownedByA, member(plain), "monitors:read")).digest).toBe(NOT_FOUND);
  });

  it("checks the row's workspace, not the member's: a member record naming B does not open B's rows", () => {
    const confused: Member = { caller: adminOfA, workspace: B, entitlements: FREE };
    expect(thrown(() => requireIn(ownedByB, confused, "monitors:read")).digest).toBe(NOT_FOUND);
  });
});

describe("allowed", () => {
  it("is the permission check, in this workspace only", () => {
    expect(allowed(A, adminOfA, "pages:manage")).toBe(true);
    expect(allowed(B, adminOfA, "pages:manage")).toBe(false);
    expect(allowed(A, null, "pages:manage")).toBe(false);
  });
});
