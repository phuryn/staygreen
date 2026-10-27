import { existsSync } from "node:fs";
import { config } from "dotenv";
import { ACCOUNTS_FILE, readAccounts } from "./accounts";
import { deleteWorkspaces } from "./rest";

/* A run leaves nothing: the test accounts' workspaces go again, with everything they own. The
   accounts and their organizations stay, so the next run signs in instead of re-creating them. */

export default async function globalTeardown() {
  config({ quiet: true });
  if (!existsSync(ACCOUNTS_FILE)) return;
  const { a, b } = readAccounts();
  await deleteWorkspaces([a.orgId, b.orgId]);
}
