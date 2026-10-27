import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/* The cipher behind `credentials.ts`, without the dashboard's environment, so a probe can open
   what the dashboard sealed with the same key (`docs/architecture.md § Customer credentials`).

   AES-256-GCM with a random 96-bit nonce per value, and the row it belongs to as additional data,
   so a sealed value copied onto another monitor or another header fails to open instead of
   opening there. The format carries a version, so a key rotation (`docs/BACKLOG.md`) can tell old
   values from new. */

const VERSION = "v1";

/** Where a secret header's value lives, the additional data it is sealed under. */
export const headerContext = (monitorId: string, name: string) => `monitor:${monitorId}/header:${name}`;

/** `context` names where the value lives, e.g. `monitor:mon_x/header:Authorization`. */
export function seal(plaintext: string, context: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** Throws on a value sealed for another context or under another key. */
export function open(sealed: string, context: string, k: Buffer): string {
  const [version, ivPart, bodyPart] = sealed.split(".");
  if (version !== VERSION || !ivPart || !bodyPart) throw new Error("Unrecognised sealed value");
  const body = Buffer.from(bodyPart, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(ivPart, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
}
