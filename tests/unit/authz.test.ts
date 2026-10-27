import { describe, expect, it } from "vitest";
import {
  hasPermission,
  NotAllowed,
  PERMISSIONS,
  PERMISSIONS_BY_ROLE,
  requireWorkspaceAccess,
  roleInWorkspace,
  type Caller,
  type Permission,
  type WorkspaceRef,
} from "@/lib/authz";

/* Who may do what (`AGENTS.md § 1.1`, `§ 2.6`). The workspace row is resolved
   from the URL first; the caller's *active* organization is not the owner of
   what they are looking at, so membership of that workspace's organization is
   what is checked. */

const A: WorkspaceRef = { id: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", clerk_org_id: "org_A" };
const B: WorkspaceRef = { id: "ws_bbbbbbbbbbbbbbbbbbbbbbbb", clerk_org_id: "org_B" };

const adminOf = (orgId: string | null): Caller => ({ userId: "user_1", orgId, orgRole: "org:admin" });
const withRole = (orgRole: string | null): Caller => ({ userId: "user_2", orgId: "org_A", orgRole });

describe("the permission model", () => {
  it("is the list in AGENTS.md § 2.6, and admin holds all of it", () => {
    const spec = [
      "monitors:read",
      "monitors:write",
      "monitors:delete",
      "channels:manage",
      "pages:manage",
      "incidents:draft",
      "incidents:publish",
      "tokens:manage",
      "billing:manage",
      "workspace:delete",
    ];
    expect([...PERMISSIONS]).toEqual(spec);
    expect([...PERMISSIONS_BY_ROLE.admin]).toEqual(spec);
  });

  it("has one role in V1", () => {
    expect(Object.keys(PERMISSIONS_BY_ROLE)).toEqual(["admin"]);
  });
});

describe("roleInWorkspace", () => {
  it("maps Clerk's org:admin in this workspace's organization to admin", () => {
    expect(roleInWorkspace(A, adminOf("org_A"))).toBe("admin");
  });

  it("gives nobody a role when nobody is signed in", () => {
    expect(roleInWorkspace(A, null)).toBeNull();
  });

  it("gives an admin of another organization no role here, whatever their active organization holds", () => {
    expect(roleInWorkspace(B, adminOf("org_A"))).toBeNull();
    expect(roleInWorkspace(A, adminOf(null))).toBeNull();
  });

  it("never matches an empty organization id to an empty one", () => {
    expect(roleInWorkspace({ id: "ws_x", clerk_org_id: "" }, adminOf(""))).toBeNull();
  });

  it.each(["org:member", "admin", "org:admin ", "ORG:ADMIN", "", null])("gives the Clerk role %j no role: a new role is not a new capability", (orgRole) => {
    expect(roleInWorkspace(A, withRole(orgRole))).toBeNull();
  });

  // BUG (authz.ts:73): ORG_ROLES is a plain object read without an own-property check, so a
  // role string naming an Object.prototype member resolves to that member instead of null.
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("gives a role string that names an Object.prototype member no role: %s", (orgRole) => {
    expect(roleInWorkspace(A, withRole(orgRole))).toBeNull();
    expect(hasPermission(A, withRole(orgRole), "monitors:read")).toBe(false);
  });
});

describe("hasPermission and requireWorkspaceAccess", () => {
  it.each(PERMISSIONS)("lets this workspace's admin hold %s", (permission) => {
    expect(hasPermission(A, adminOf("org_A"), permission)).toBe(true);
    expect(requireWorkspaceAccess(A, adminOf("org_A"), permission)).toBe("admin");
  });

  it.each(PERMISSIONS)("refuses %s to a member whose role holds nothing", (permission) => {
    expect(hasPermission(A, withRole("org:member"), permission)).toBe(false);
    expect(() => requireWorkspaceAccess(A, withRole("org:member"), permission)).toThrow(NotAllowed);
  });

  it.each(PERMISSIONS)("refuses %s to another workspace's admin (cross-tenant)", (permission) => {
    expect(hasPermission(B, adminOf("org_A"), permission)).toBe(false);
    expect(() => requireWorkspaceAccess(B, adminOf("org_A"), permission)).toThrow(NotAllowed);
  });

  it("refuses the signed-out", () => {
    expect(hasPermission(A, null, "monitors:read")).toBe(false);
    expect(() => requireWorkspaceAccess(A, null, "monitors:read")).toThrow(NotAllowed);
  });

  it("refuses even an admin a permission the model does not define", () => {
    const invented = "monitors:nuke" as Permission;
    expect(hasPermission(A, adminOf("org_A"), invented)).toBe(false);
    expect(() => requireWorkspaceAccess(A, adminOf("org_A"), invented)).toThrow(NotAllowed);
  });

  it("names the refused permission, and only that", () => {
    let caught: unknown;
    try {
      requireWorkspaceAccess(B, adminOf("org_A"), "billing:manage");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotAllowed);
    expect((caught as Error).name).toBe("NotAllowed");
    expect((caught as Error).message).toContain("billing:manage");
    expect((caught as Error).message).not.toContain("org_A");
  });
});
