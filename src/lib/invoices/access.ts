import "server-only";
import { env } from "@/lib/env";
import { allowed, memberOrNull, type Member } from "@/lib/workspace";

export function invoicesAvailable(member: Member): boolean {
  return !!env().INVOICE_SERVICE_URL && allowed(member.workspace, member.caller, "billing:manage");
}

/** Resolve the service customer only after checking access to the active workspace. */
export async function invoiceBillingCustomer(): Promise<string | null> {
  if (!env().INVOICE_SERVICE_URL) return null;
  const member = await memberOrNull();
  if (!member || !allowed(member.workspace, member.caller, "billing:manage")) return null;
  return member.workspace.clerk_org_id;
}
