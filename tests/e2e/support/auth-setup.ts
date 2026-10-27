import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "dotenv";
import { clerkSetup } from "@clerk/testing/playwright";
import { ACCOUNTS_FILE, STATE, emails, type Account } from "./accounts";
import { findOrCreateOrg, findOrCreateUser } from "./clerk-api";
import { deleteWorkspaces } from "./rest";

/* Before any browser opens (`docs/TESTS.md § The authenticated mile`):
   1. refuse to start without a Clerk test address, the fixed code and a development key;
   2. fetch Clerk's testing token here, in globalSetup, because a worker inherits the
      environment of the process that spawned it and nothing after (`§ Rules that came from bugs`);
   3. find or create both test accounts, each with an organization of its own, since
      organizations are on with Membership required and a session without one is signed out;
   4. delete everything their workspaces own, so a run starts from nothing.
   It never creates a workspace row: the app's session seam does that on first sight, the path
   a real member takes. */

export default async function globalSetup() {
  config({ quiet: true });
  const mail = emails();
  if (!process.env.TEST_VERIFICATION_CODE) throw new Error("TEST_VERIFICATION_CODE must be set (Clerk development instances accept it for +clerk_test addresses)");

  process.env.CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  await clerkSetup();

  const accounts = {} as Record<"a" | "b", Account>;
  for (const key of ["a", "b"] as const) {
    const user = await findOrCreateUser(mail[key]);
    const orgName = `Staygreen e2e ${key.toUpperCase()}`;
    const org = await findOrCreateOrg(user.id, orgName);
    accounts[key] = { key, email: mail[key], userId: user.id, orgId: org.id, orgName: org.name };
  }
  if (accounts.a.orgId === accounts.b.orgId) throw new Error("the two test accounts share an organization; the cross-tenant journeys need two");

  await deleteWorkspaces([accounts.a.orgId, accounts.b.orgId]);

  mkdirSync(dirname(STATE.a), { recursive: true });
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
