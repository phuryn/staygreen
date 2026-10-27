import { beforeEach, expect, it, vi } from "vitest";
import Page from "@/app/(app)/app/apps/[id]/checks/page";
import { FREE } from "@/lib/plans";

const fake = vi.hoisted(() => ({ member: vi.fn(), resolve: vi.fn(), snapshot: vi.fn() }));
vi.mock("@/lib/workspace", async original => ({
  ...await original<typeof import("@/lib/workspace")>(),
  requireMemberWith: async (_path: string, resolve: () => Promise<unknown>) => [fake.member(), await resolve()],
  resolveApp: fake.resolve, loadSnapshot: fake.snapshot,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("404"); } }));
vi.mock("@/lib/workspace-store", () => ({ WorkspaceSnapshot: () => null }));
vi.mock("@/app/(app)/app/apps/[id]/checks/ChecksScreen", () => ({ ChecksScreen: () => null }));
const ws = { id: "ws_a", clerk_org_id: "org_a" };
const admin = { caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, workspace: ws, entitlements: FREE };
beforeEach(() => {
  vi.clearAllMocks();
  fake.member.mockReturnValue(admin);
  fake.resolve.mockResolvedValue({ id: "app_a", workspace: ws });
  fake.snapshot.mockResolvedValue({});
});

it("resolves the app before returning its workspace snapshot", async () => {
  await Page({ params: Promise.resolve({ id: "app_a" }) });
  expect(fake.resolve).toHaveBeenCalledWith("app_a");
  expect(fake.snapshot).toHaveBeenCalledWith(admin);
});

it.each(["missing", "foreign", "forbidden"])("returns the same 404 for a %s app without reading its snapshot", async kind => {
  if (kind === "missing") fake.resolve.mockResolvedValue(null);
  if (kind === "foreign") fake.resolve.mockResolvedValue({ id: "app_a", workspace: { id: "ws_b", clerk_org_id: "org_b" } });
  if (kind === "forbidden") fake.member.mockReturnValue({ ...admin, caller: { ...admin.caller, orgRole: "org:member" } });
  await expect(Page({ params: Promise.resolve({ id: "app_a" }) })).rejects.toThrow("404");
  expect(fake.snapshot).not.toHaveBeenCalled();
});
