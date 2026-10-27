/* Who may do what (`AGENTS.md § 1.1`, `§ 2.6`).

   Pure, so the unit suite can hold the whole model: no database, no request,
   no Clerk. The rules it encodes:

   - Permissions are strings; roles map to them. Code checks permissions.
   - The caller's active organization is not the owner of the thing they are
     looking at. So the resource is resolved from the URL first, its workspace
     found, and membership of *that* workspace checked.

   Every workspace is a Clerk organization (`§ 2.3`). V1 has one role, admin,
   which holds every permission. The strings exist anyway, so the agent scopes
   of Phase 3 and a second role later have a gate to meet. */

export const PERMISSIONS = [
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role = "admin";

export const PERMISSIONS_BY_ROLE: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
};

/** A verified Clerk session, reduced to what authorization needs. Never a
 *  decoded token: `session.ts` is the only place that produces one. */
export type Caller = {
  userId: string;
  /** The caller's *active* organization, or null. */
  orgId: string | null;
  /** Clerk's role string for that organization, e.g. `org:admin`. */
  orgRole: string | null;
};

/** Just enough of a `workspaces` row to decide. */
export type WorkspaceRef = {
  id: string;
  clerk_org_id: string;
};

export class NotAllowed extends Error {
  constructor(permission: Permission) {
    super(`Not allowed: ${permission}`);
    this.name = "NotAllowed";
  }
}

/** Clerk's role strings, mapped onto ours. Anything not named here holds
 *  nothing: a new Clerk role is not a new capability until someone adds it.
 *  `org:admin` is the role Clerk gives whoever creates an organization. */
const ORG_ROLES: Record<string, Role> = {
  "org:admin": "admin",
};

export function roleInWorkspace(workspace: WorkspaceRef, caller: Caller | null): Role | null {
  if (!caller) return null;
  // Membership of *this* workspace's organization, not of whichever one the
  // caller happens to have active. This one comparison is the whole
  // cross-tenant boundary: everything else resolves the resource first and
  // then asks this.
  if (!workspace.clerk_org_id || workspace.clerk_org_id !== caller.orgId) return null;
  const role = caller.orgRole ?? "";
  // Own keys only: "toString" is not a role.
  return Object.hasOwn(ORG_ROLES, role) ? ORG_ROLES[role] : null;
}

export function hasPermission(workspace: WorkspaceRef, caller: Caller | null, permission: Permission): boolean {
  const role = roleInWorkspace(workspace, caller);
  return role !== null && PERMISSIONS_BY_ROLE[role].includes(permission);
}

/** Throws unless the caller holds the permission in *that* workspace.
 *
 *  `§ 1.1` writes this as `requireWorkspaceAccess(workspaceId, auth, permission)`;
 *  the workspace row is passed instead of its id because every caller has just
 *  resolved it, and re-reading it would be a second query that could disagree
 *  with the first. */
export function requireWorkspaceAccess(workspace: WorkspaceRef, caller: Caller | null, permission: Permission): Role {
  const role = roleInWorkspace(workspace, caller);
  if (role === null || !PERMISSIONS_BY_ROLE[role].includes(permission)) throw new NotAllowed(permission);
  return role;
}
