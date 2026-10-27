import { notFound, redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/authz";
import { requireMemberWith } from "@/lib/workspace";

/* A detail page's first line (`requireMemberWith`, `src/lib/workspace.ts`): the member and the row
   its URL names, read side by side so the page waits on one round trip, not two. A signed-out
   visitor still goes to sign-in before any read, and a caller whose role holds nothing still gets
   the stranger's 404. The session and the database are faked; the 404 itself is `requireIn`'s,
   tested in `workspace.test.ts`. */

const fake = vi.hoisted(() => ({ caller: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/session", () => ({ currentCaller: fake.caller, currentEntitlements: async () => ({}) }));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc: fake.rpc }) }));

const PATH = "/app/monitors/mon_aaaaaaaaaaaaaaaaaaaaaaaa";
const admin: Caller = { userId: "user_1", orgId: "org_A", orgRole: "org:admin" };
const row = { id: "mon_aaaaaaaaaaaaaaaaaaaaaaaa", workspace: { id: "ws_a", clerk_org_id: "org_A" } };

const digestOf = async (run: () => unknown) => {
  try {
    await run();
  } catch (e) {
    return (e as { digest?: string }).digest;
  }
  throw new Error("expected a throw");
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireMemberWith", () => {
  it("sends a signed-out visitor to sign-in and back, before any read", async () => {
    fake.caller.mockResolvedValue(null);
    const resolve = vi.fn(async () => row);
    expect(await digestOf(() => requireMemberWith(PATH, resolve))).toBe(await digestOf(() => redirect(`/sign-in?redirect_url=${encodeURIComponent(PATH)}`)));
    expect(resolve).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("reads the row while the member is still being looked up, and returns both", async () => {
    fake.caller.mockResolvedValue(admin);
    let answer: (v: unknown) => void = () => {};
    fake.rpc.mockReturnValue(new Promise((done) => { answer = done; }));
    const resolve = vi.fn(async () => row);
    const both = requireMemberWith(PATH, resolve);
    await new Promise((tick) => setTimeout(tick, 0));
    expect(fake.rpc).toHaveBeenCalledWith("ensure_workspace", { p_clerk_org_id: "org_A" });
    expect(resolve).toHaveBeenCalledTimes(1);
    answer({ data: { id: "ws_a", clerk_org_id: "org_A" }, error: null });
    const [member, got] = await both;
    expect(member.workspace).toEqual({ id: "ws_a", clerk_org_id: "org_A" });
    expect(got).toBe(row);
  });

  it("gives a caller whose role holds nothing the stranger's 404, and creates no workspace", async () => {
    fake.caller.mockResolvedValue({ ...admin, orgRole: "org:member" });
    expect(await digestOf(() => requireMemberWith(PATH, async () => row))).toBe(await digestOf(() => notFound()));
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});
