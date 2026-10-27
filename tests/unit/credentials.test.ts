import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "@/lib/credentials";

/* Customer credentials at rest (`AGENTS.md § 2.8`): AES-256-GCM with a random
   nonce per value and the row it belongs to as additional data. The key is a
   throwaway made here and handed in through the module's own parameter;
   `CREDENTIALS_KEY` and `.env` are never read. */

const KEY = randomBytes(32);
const CONTEXT = "monitor:mon_aaaaaaaaaaaaaaaaaaaaaaaa/header:Authorization";
const SECRET = "Bearer sk_live_Fa1keFa1keFa1keFa1ke";

/** The sealed value with one byte of its body flipped. */
function flipBodyByte(sealed: string, at: number): string {
  const [version, iv, body] = sealed.split(".");
  const bytes = Buffer.from(body, "base64url");
  bytes[at] ^= 0x01;
  return `${version}.${iv}.${bytes.toString("base64url")}`;
}

describe("seal and open", () => {
  it("round-trips a value under the same key and context", () => {
    expect(open(seal(SECRET, CONTEXT, KEY), CONTEXT, KEY)).toBe(SECRET);
  });

  it.each(["", "ünïcödé ✓ 密码", "x".repeat(4096), "line\nbreak"])("round-trips %j", (plaintext) => {
    expect(open(seal(plaintext, CONTEXT, KEY), CONTEXT, KEY)).toBe(plaintext);
  });

  it("writes a versioned value that does not contain the plaintext", () => {
    const sealed = seal(SECRET, CONTEXT, KEY);
    expect(sealed.split(".")).toHaveLength(3);
    expect(sealed.split(".")[0]).toBe("v1");
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain(Buffer.from(SECRET).toString("base64url"));
  });

  it("uses a fresh nonce every time, so the same secret never seals the same way twice", () => {
    const a = seal(SECRET, CONTEXT, KEY);
    const b = seal(SECRET, CONTEXT, KEY);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });
});

describe("open refuses", () => {
  const sealed = seal(SECRET, CONTEXT, KEY);
  const bodyLength = Buffer.from(sealed.split(".")[2], "base64url").length;

  it("a tampered ciphertext byte", () => {
    expect(() => open(flipBodyByte(sealed, 0), CONTEXT, KEY)).toThrow();
  });

  it("a tampered authentication tag", () => {
    expect(() => open(flipBodyByte(sealed, bodyLength - 1), CONTEXT, KEY)).toThrow();
  });

  it("a tampered nonce", () => {
    const [version, iv, body] = sealed.split(".");
    const nonce = Buffer.from(iv, "base64url");
    nonce[0] ^= 0x01;
    expect(() => open(`${version}.${nonce.toString("base64url")}.${body}`, CONTEXT, KEY)).toThrow();
  });

  it("the wrong key", () => {
    expect(() => open(sealed, CONTEXT, randomBytes(32))).toThrow();
  });

  it("a value copied onto another monitor or another header", () => {
    expect(() => open(sealed, "monitor:mon_bbbbbbbbbbbbbbbbbbbbbbbb/header:Authorization", KEY)).toThrow();
    expect(() => open(sealed, "monitor:mon_aaaaaaaaaaaaaaaaaaaaaaaa/header:X-Api-Key", KEY)).toThrow();
  });

  it("a value cut short", () => {
    const [version, iv, body] = sealed.split(".");
    const short = Buffer.from(body, "base64url").subarray(0, bodyLength - 4).toString("base64url");
    expect(() => open(`${version}.${iv}.${short}`, CONTEXT, KEY)).toThrow();
  });

  it.each(["", "v1", "v1.", "v1..", `v2.${sealed.split(".").slice(1).join(".")}`, SECRET])("a value that is not a v1 sealed value: %j", (bad) => {
    expect(() => open(bad, CONTEXT, KEY)).toThrow();
  });
});

describe("the key", () => {
  it("must be 32 bytes", () => {
    expect(() => seal(SECRET, CONTEXT, randomBytes(16))).toThrow();
    expect(() => seal(SECRET, CONTEXT, randomBytes(31))).toThrow();
  });
});
