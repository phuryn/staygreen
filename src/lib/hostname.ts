import { z } from "zod";

/** Configuration interpolated into URLs, Caddy and Cloudflare expressions: DNS only. */
export const hostnameSchema = z.string().max(253).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Use a lowercase hostname without a scheme, port or path",
);
