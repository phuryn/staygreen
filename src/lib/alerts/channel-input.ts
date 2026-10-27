import { z } from "zod";
import { ipVersion, isLocalName, isPublicIp } from "../ip";

/** URLs are credentials; validation errors never echo any portion of one. */
export function webhookUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443") ||
        isLocalName(host) || (ipVersion(host) && !isPublicIp(host))) return null;
    return u;
  } catch { return null; }
}

export function discordUrl(value: string): URL | null {
  const u = webhookUrl(value);
  if (!u || !["discord.com", "discordapp.com"].includes(u.hostname) || u.search ||
      !/^\/api(?:\/v10)?\/webhooks\/\d{17,22}\/[A-Za-z0-9_-]{40,150}$/.test(u.pathname)) return null;
  u.hostname = "discord.com";
  return u;
}

export const channelInput = z.object({
  kind: z.enum(["discord", "webhook"]),
  label: z.string().trim().min(1, "Give this channel a name.").max(120),
  url: z.string().trim().max(2048),
  // Supplied by the receiver's owner, never returned after save.
  secret: z.string().max(256).optional(),
}).superRefine((v, ctx) => {
  if (!(v.kind === "discord" ? discordUrl(v.url) : webhookUrl(v.url)))
    ctx.addIssue({ code: "custom", path: ["url"], message: v.kind === "discord" ? "Paste a Discord channel webhook URL." : "Use a public HTTPS address on port 443, without a login or fragment." });
  if (v.kind === "webhook" && (!v.secret || !/^[A-Za-z0-9_-]{32,256}$/.test(v.secret)))
    ctx.addIssue({ code: "custom", path: ["secret"], message: "Use a random signing secret of 32–256 letters, digits, underscores or hyphens." });
});

export const routeInput = z.object({
  appId: z.string().regex(/^app_[0-9a-f]{24}$/),
  monitorId: z.string().regex(/^mon_[0-9a-f]{24}$/).nullable(),
  severity: z.enum(["all", "incident", "warning"]),
  channelIds: z.array(z.string().regex(/^chan_[0-9a-f]{24}$/)).max(100).nullable(),
});

export const channelContext = (workspace: string, id: string) => `workspace:${workspace}/channel:${id}`;
