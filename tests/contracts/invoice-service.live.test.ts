import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHttpInvoiceService } from "@/lib/invoices/service";
import { invoiceServiceBehavior } from "./invoice-service.behavior";
import { invoiceContractTarget } from "./invoice-target";
// No dotenv/setup.ts, local config fallback or skip. This opt-in suite may write
// only staygreen-contract-test; the service team resets it before every run.
const target = invoiceContractTarget(process.env);
invoiceServiceBehavior("deployed invoice service v1", () => createHttpInvoiceService(target.baseUrl, target.key));
