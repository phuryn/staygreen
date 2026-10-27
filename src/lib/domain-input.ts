import { z } from "zod";
import { hostnameSchema } from "./hostname";

export const domainSchema = z.string().trim().toLowerCase().max(253).regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Enter a hostname like status.yourapp.com, without a scheme, port or path",
).refine(v => v !== "staygreen.io" && !v.endsWith(".staygreen.io"), "Choose a domain you own");

// Validate the stored claim's shape, not today's suffix: existing claims keep their target.
export const cnameTargetSchema = z.string().trim().toLowerCase().pipe(hostnameSchema.regex(
  /^[a-f0-9]{32}\./, "Use the CNAME target shown for this domain in the page editor",
));
export const matchesCname = (records: string[], target: string) => cnameTargetSchema.safeParse(target).success &&
  records.some(v => v.toLowerCase().replace(/\.$/, "") === target.toLowerCase());
