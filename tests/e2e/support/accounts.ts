import { readFileSync } from "node:fs";
import { join } from "node:path";

/* The authenticated suite's two accounts (`docs/TESTS.md § The authenticated mile`). One value
   is set, `TEST_ADMIN_EMAIL`; the second admin, in a workspace of its own for the cross-tenant
   journeys, is derived from it, so there is no way to set it half-way. V1 has one role, admin
   (`src/lib/authz.ts`); a second role adds an account here. */

const DIR = join(__dirname, "..");

/** What `globalSetup` found or created, for the journeys and the teardown. Gitignored. */
export const ACCOUNTS_FILE = join(DIR, ".auth.json");

/** Each account's saved session, written by `sign-in.setup.ts`. Gitignored. */
export const STATE = { a: join(DIR, ".auth", "a.json"), b: join(DIR, ".auth", "b.json") };

export type Account = { key: "a" | "b"; email: string; userId: string; orgId: string; orgName: string };

export function emails(): { a: string; b: string } {
  const a = process.env.TEST_ADMIN_EMAIL ?? "";
  if (!a.includes("+clerk_test@")) throw new Error("TEST_ADMIN_EMAIL must be a Clerk test address carrying +clerk_test");
  return { a, b: a.replace("+clerk_test@", "-b+clerk_test@") };
}

export function readAccounts(): Record<"a" | "b", Account> {
  return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
}
