import { invoiceServiceHttpsUrl, invoiceServiceKey } from "@/lib/env-schema";

export function invoiceContractTarget(source: Record<string, string | undefined>) {
  const baseUrl = source.INVOICE_SERVICE_URL, key = source.INVOICE_SERVICE_KEY;
  if (!baseUrl || baseUrl === "mock" || !key?.trim()) throw new Error("Live invoice contract tests require an HTTPS INVOICE_SERVICE_URL and INVOICE_SERVICE_KEY from the process environment; mock is refused.");
  if (!invoiceServiceHttpsUrl.safeParse(baseUrl).success) throw new Error("INVOICE_SERVICE_URL must be an HTTPS base URL without credentials, query or fragment.");
  if (!invoiceServiceKey.safeParse(key).success) throw new Error("INVOICE_SERVICE_KEY must be a bearer key without spaces or control characters.");
  return { baseUrl, key };
}
