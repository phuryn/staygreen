import { describe, expect, it } from "vitest";
import { isSecretName, mask, maskField, maskHeader, redact, redactValues, snippet } from "../../src/checks/mask";

/* The masker (`spec.md § 2`): nothing a response body echoes back — a key, a token, an address —
   reaches an incident, an alert or the database. The fake keys are assembled at run time so the
   file itself never holds a string a secret scanner would stop a push for. */

const DOTS = "•••";
const k = (...parts: string[]) => parts.join("");

describe("mask", () => {
  it("leaves ordinary text alone", () => {
    const text = '{"status":"ok","db":{"latency_ms":12},"message":"All systems go on the Basic plan"}';
    expect(mask(text)).toBe(text);
  });

  it("masks the builder's own secret header values, as sent and URL-encoded", () => {
    const value = "s3cr3t value/+";
    const out = mask(`echo: ${value} and ${encodeURIComponent(value)}`, [value]);
    expect(out).toBe(`echo: ${DOTS} and ${DOTS}`);
  });

  it("masks the credential after its scheme, and a value as JSON escapes it", () => {
    expect(mask('{"debug":"s3cr3t-value-9f"}', ["Bearer s3cr3t-value-9f"])).toBe(`{"debug":"${DOTS}"}`);
    const quoted = 'k"ey\\value';
    expect(mask(JSON.stringify({ seen: quoted }), [quoted])).toBe(`{"seen":"${DOTS}"}`);
  });

  it("masks a value as an encoder that escapes slashes writes it", () => {
    expect(mask('{"seen":"ab\\/cd\\/ef12"}', ["ab/cd/ef12"])).toBe(`{"seen":"${DOTS}"}`);
  });

  it("takes the credential after any scheme word, only when it is long enough to be one", () => {
    expect(redact("a test of the token", ["Bearer test", "Token token"])).toBe("a test of the token");
    expect(redact('{"token":"monday-token-9f2a"}', ["Api-Key monday-token-9f2a"])).toBe(`{"token":"${DOTS}"}`);
    expect(redact("x s3cr3t-value-9f", ["Zoho-oauthtoken s3cr3t-value-9f"])).toBe(`x ${DOTS}`);
  });

  it("hides secrets in decoded JSON strings, keys and numbers, and the JSON stays whole", () => {
    expect(redactValues({ seen: "ab/cd/ef12", count: 1234, ok: true, list: ["x ab/cd/ef12"] }, ["ab/cd/ef12"])).toEqual({ seen: DOTS, count: 1234, ok: true, list: [`x ${DOTS}`] });
    expect(redactValues({ id: 8392017465, n: 7, ["8392017465"]: "ok" }, ["Bearer 8392017465"])).toEqual({ id: DOTS, n: 7, [DOTS]: "ok" });
  });

  it("redacts only the builder's own secrets, which is what a check judges", () => {
    expect(redact("token s3cr3t-value-9f for ana@example.com", ["Bearer s3cr3t-value-9f"])).toBe(`token ${DOTS} for ana@example.com`);
  });

  it("masks a longer secret whole when it contains a shorter one", () => {
    expect(mask("key=abcd1234efgh", ["abcd", "abcd1234efgh"])).toBe(`key=${DOTS}`);
  });

  it("ignores secret values too short to mask without wrecking the body", () => {
    expect(mask("a b c", ["a"])).toBe("a b c");
  });

  it("masks Authorization values, and keeps a word after Basic that isn't a credential", () => {
    expect(mask("Authorization: Bearer abc.def-ghi_jkl")).toBe(`Authorization: Bearer ${DOTS}`);
    expect(mask("authorization: bearer abc")).toBe(`authorization: bearer ${DOTS}`);
    expect(mask("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Authorization: Basic ${DOTS}`);
    expect(mask("Upgrade from the Basic plan")).toBe("Upgrade from the Basic plan");
  });

  it("masks the values of JSON keys that are secrets, whatever they look like", () => {
    const out = mask('{"password":"hunter2","api_key":"x","Session-Id":"42","name":"ok"}');
    expect(out).toBe(`{"password":"${DOTS}","api_key":"${DOTS}","Session-Id":"${DOTS}","name":"ok"}`);
  });

  it.each([
    ["a JWT", k("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", "c2lnbmF0dXJl")],
    ["a Stripe secret key", k("sk_", "live_", "51Habcdefghijklmnop")],
    ["a Stripe webhook secret", k("whsec", "_test_", "abcdefgh12345678")],
    ["an OpenAI-style key", k("sk-", "proj-abcdefghijklmnop")],
    ["a GitHub token", k("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789")],
    ["a fine-grained GitHub token", k("github", "_pat_", "11ABCDEFG0123456789_abcdef")],
    ["a Slack token", k("xox", "b-", "123456789012-abcdefghij")],
    ["an AWS access key id", k("AKIA", "ABCDEFGHIJKLMNOP")],
    ["a Supabase secret key", k("sb_", "secret_", "abcdefghijklmnop")],
    ["an email address", "someone.else+tag@example.co.uk"],
    ["a long hex string", "0123456789abcdef0123456789abcdef01"],
    ["a random base64 run", "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRg"],
  ])("masks %s", (_, secret) => {
    expect(mask(`before ${secret} after`)).toBe(`before ${DOTS} after`);
  });

  it("masks a prefixed key glued to an underscore, and not a prefix inside a word", () => {
    const key = k("sk_", "live_", "abcdefghijklmnop");
    expect(mask(`STRIPE_KEY_${key}`)).toBe(`STRIPE_KEY_${DOTS}`);
    expect(mask("the task_live_abcdefgh flag")).toBe("the task_live_abcdefgh flag");
  });

  it("keeps long runs that don't look random: words, paths, lowercase slugs", () => {
    const text = "/api/v1/very-long-lowercase-path-without-digits-at-all and ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH";
    expect(mask(text)).toBe(text);
  });
});

describe("snippet", () => {
  it("is the masked body when it fits", () => {
    expect(snippet('{"token":"abc"}')).toBe(`{"token":"${DOTS}"}`);
  });

  it("cuts to 300 bytes of UTF-8 without splitting a character", () => {
    const body = "é".repeat(400); // two bytes each
    const out = snippet(body);
    expect(Buffer.byteLength(out, "utf8")).toBe(300);
    expect(out).toBe("é".repeat(150));
    const odd = "a" + "€".repeat(200); // 1 + 3 bytes each: 300 falls inside a character
    const cut = snippet(odd);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(300);
    expect(cut).toBe("a" + "€".repeat(99));
  });

  it("masks before it cuts, so a secret across the cut leaves nothing readable", () => {
    const secret = k("sk_", "live_", "abcdefghijklmnopqrstuvwxyz");
    const body = "x".repeat(290) + " " + secret;
    const out = snippet(body);
    expect(out).toBe("x".repeat(290) + " " + DOTS);
    expect(out).not.toContain("sk_");
  });

  it("reads bytes as UTF-8 and survives invalid sequences", () => {
    const bytes = new Uint8Array([0x6f, 0x6b, 0xff, 0x20, 0x21]);
    expect(snippet(bytes)).toBe("ok� !");
  });
});

describe("what the test of a monitor shows beside the body (`src/lib/monitor-test.ts`)", () => {
  it("names the JSON keys the body's text is masked by, whole and in any case", () => {
    for (const name of ["token", "api_key", "apiKey", "Authorization", "client-secret", "session_id", "password"]) expect(isSecretName(name)).toBe(true);
    for (const name of ["status", "tokens", "my_token", "session_count", "key"]) expect(isSecretName(name)).toBe(false);
  });

  it("hides a JSON value whole under a secret's key, and masks any other the way the text is", () => {
    expect(maskField("token", "plain-looking")).toBe(DOTS);
    expect(maskField("user", "ana@example.com")).toBe(DOTS);
    expect(maskField("echo", "the s3cr3t", ["s3cr3t"])).toBe(`the ${DOTS}`);
    expect(maskField(null, "ok")).toBe("ok");
    // The tree and the masked text agree on what they hide.
    const body = JSON.stringify({ token: "plain-looking", status: "ok" });
    expect(mask(body)).toBe(`{"token":"${DOTS}","status":"ok"}`);
  });

  it("hides a header named like a secret, a dash-prefixed one too", () => {
    for (const name of ["authorization", "x-api-key", "X-Auth-Token", "x-amz-security-token", "x-session-id"]) expect(maskHeader(name, "anything")).toBe(DOTS);
    expect(maskHeader("content-type", "application/json")).toBe("application/json");
    expect(maskHeader("x-tokens-left", "12")).toBe("12");
  });

  it("keeps a set cookie's name and attributes but never its value", () => {
    expect(maskHeader("set-cookie", "session=abc; Path=/; HttpOnly; Secure")).toBe(`session=${DOTS}; Path=/; HttpOnly; Secure`);
    expect(maskHeader("Set-Cookie", "theme=dark")).toBe(`theme=${DOTS}`);
  });

  it("masks the builder's own secret and the patterns in any other header", () => {
    expect(maskHeader("x-echo", "got s3cr3t-value", ["s3cr3t-value"])).toBe(`got ${DOTS}`);
    expect(maskHeader("location", "https://example.com/?u=ana@example.com")).toBe(`https://example.com/?u=${DOTS}`);
    expect(maskHeader("x-trace", k("sk_", "live_", "abcdefghijklmnop"))).toBe(DOTS);
  });
});
