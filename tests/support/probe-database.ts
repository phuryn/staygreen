import { randomBytes } from "node:crypto";
import pg from "pg";

/** Fixtures alone use the local owner. Every Store gets a real, separate login, not SET ROLE
 * on an owner connection (which could silently RESET ROLE). Never use a shared database.
 * `group` is the group role the login inherits: `probe` for a probe, `ingest` for the
 * heartbeat Worker (migration 019), `service_role` for the server's key, for dashboard sends
 * (`servicePool` below), or `alert_sender` for the Worker (migration 027). */
export async function probeDatabase(url: string, group: "probe" | "ingest" | "service_role" | "watchdog" | "alert_sender" | "edge" = "probe") {
  const address = new URL(url);
  if (!["postgres:", "postgresql:"].includes(address.protocol) ||
      !["localhost", "127.0.0.1"].includes(address.hostname) || address.search || address.hash) {
    throw new Error("PROBE_DATABASE_URL must name local Postgres, with no query parameters or fragment");
  }
  const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2_000 });
  const role = `${group}_test_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  let created = false;
  try {
    await admin.query(`create role ${role} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${password}'`);
    created = true;
    await admin.query(`grant ${group} to ${role}`);
    address.username = role;
    address.password = password;
    return {
      admin, role, probeUrl: address.toString(),
      async close() {
        try { await admin.query(`drop role ${role}`); } finally { await admin.end(); }
      },
    };
  } catch (error) {
    try { if (created) await admin.query(`drop role ${role}`); } finally { await admin.end(); }
    throw error;
  }
}

/** A pool on a login that is a member of `service_role`, acting as it. Supabase's `service_role`
 * has BYPASSRLS, and a role attribute isn't inherited, so each connection starts as the role
 * (`-c role=`, the startup form of SET ROLE), as PostgREST acts as it for the server's key; a
 * RESET ROLE falls back to the bare login, which holds less, never more. */
export function servicePool(serviceUrl: string) {
  return new pg.Pool({ connectionString: serviceUrl, max: 6, connectionTimeoutMillis: 2_000, options: "-c role=service_role" });
}
