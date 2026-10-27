/* The masker (`spec.md § 2`): every snippet passes through here before it is stored or sent, so
   a response body that echoes a token, a key or an address never reaches an alert, an incident
   page or the database. One module, one entry point, with its own tests.

   It masks the whole body first and cuts it second: cutting first could leave half a secret
   that no pattern recognizes any more. */

const DOTS = "•••";

/** Names whose values are secrets whatever they look like: JSON keys, and header names. */
const SECRET_NAMES = "password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|authorization|cookie|session(?:[_-]?id)?";
/** A JSON key of one of those names and its string value, in a body's text. */
const SECRET_KEYS = new RegExp(String.raw`("(?:${SECRET_NAMES})"\s*:\s*")((?:[^"\\]|\\.)*)(")`, "gi");
const SECRET_NAME = new RegExp(`^(?:${SECRET_NAMES})$`, "i");
/** A header named so, or ending in one of the names after a dash: `x-api-key`, `x-auth-token`. */
const SECRET_HEADER = new RegExp(`(?:^|-)(?:${SECRET_NAMES})$`, "i");

// A prefixed token starts after anything but a letter or digit. Not `\b`: an underscore is a word
// character, and `STRIPE_KEY_sk_live_…` is how a key sits in an echoed environment dump.
const PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])sg_[0-9a-f]{24}\.[A-Za-z0-9_-]{43}/g,
  // JWTs, before anything that would eat one of their segments.
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g,
  // Stripe-style keys, and the common prefixed tokens of other services.
  /(?<![A-Za-z0-9])(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /(?<![A-Za-z0-9])(?:sk|rk|pk)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g,
  // Emails.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  // Long hex: hashes, API keys, session ids.
  /\b[0-9a-fA-F]{32,}\b/g,
];

/** A run of base64 or base64url characters long enough to be a key, with the mix of cases and
 *  digits that real keys have and long words and paths don't. */
const BASE64ISH = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const looksRandom = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

/** Every form one of the builder's own secret header values can come back in as text: the
 *  value, the credential after a scheme word (`Bearer`, `Api-Key`, any) when it is long enough to
 *  be one, and each
 *  URL-encoded and JSON-escaped (with and without `\/`). At least 4 characters, longest first, so
 *  one that contains another goes whole. */
function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of secrets) {
    const scheme = /^[A-Za-z][A-Za-z0-9._~+-]{0,29}\s+(\S{8,})$/.exec(value);
    for (const v of scheme ? [value, scheme[1]] : [value]) {
      if (v.length < 4) continue;
      const json = JSON.stringify(v).slice(1, -1);
      for (const form of [v, encodeURIComponent(v), json, json.replaceAll("/", "\\/")]) forms.add(form);
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** The text with the builder's own secret values hidden, and nothing else. A check judges the
 *  body through it (`http.ts`), so a keyword or an assertion can never ask what a secret holds,
 *  and a monitor that guesses at an echoed header learns nothing from passing or failing. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const form of secretForms(secrets)) out = out.split(form).join(DOTS);
  return out;
}

/** Parsed JSON with the builder's own secret values hidden. What a check's assertions read:
 *  decoded first, so no escaping lets a secret through. A string or key loses the secret inside
 *  it, and a number or boolean whose text holds one becomes the dots, so no comparison can read
 *  it and the JSON stays whole. */
export function redactValues(v: unknown, secrets: readonly string[] = []): unknown {
  if (!secrets.length) return v;
  if (typeof v === "string") return redact(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactValues(x, secrets));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k, secrets), redactValues(x, secrets)]));
  if (typeof v === "number" || typeof v === "boolean") return redact(String(v), secrets) === String(v) ? v : DOTS;
  return v;
}

export function mask(text: string, secrets: readonly string[] = []): string {
  let out = redact(text, secrets);
  // Authorization values. "Basic" needs a credential-length run after it, so prose that says
  // "Basic plan" survives.
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${DOTS}`);
  out = out.replace(/\b(Basic)\s+[A-Za-z0-9+/]{12,}={0,2}/g, `$1 ${DOTS}`);
  out = out.replace(SECRET_KEYS, `$1${DOTS}$3`);
  for (const p of PATTERNS) out = out.replace(p, DOTS);
  out = out.replace(BASE64ISH, (m) => (looksRandom(m) ? DOTS : m));
  return out;
}

/** A body as text, the one way every reader of a body decodes it (the check, the dashboard's test,
 *  the suggestions, the snippet): UTF-8, with a leading byte-order mark dropped, which `JSON.parse`
 *  would otherwise refuse. */
export const bodyText = (body: Uint8Array): string => new TextDecoder().decode(body);

/** How much of a response a failed check keeps, in bytes after masking (`AGENTS.md § 2.8`). The
 *  privacy policy quotes it. */
export const SNIPPET_BYTES = 300;

/** The stored and sent form of a body: masked, then cut to `maxBytes` of UTF-8 without
 *  splitting a character. */
export function snippet(body: string | Uint8Array, secrets: readonly string[] = [], maxBytes = SNIPPET_BYTES): string {
  const text = typeof body === "string" ? body : bodyText(body);
  const masked = mask(text, secrets);
  const bytes = Buffer.from(masked, "utf8");
  if (bytes.length <= maxBytes) return masked;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/* What the dashboard's test of a monitor shows besides the body's text (`src/lib/monitor-test.ts`):
   the body read as JSON, value by value, and the response headers. */

/** Whether a JSON key holds a secret whatever its value looks like: the names the body's text is
 *  masked by, so the tree and the text hide the same values. */
export const isSecretName = (name: string) => SECRET_NAME.test(name);

/** One string value of a JSON body, under its key: hidden whole when the key names a secret,
 *  else through `mask`. */
export function maskField(key: string | null, value: string, secrets: readonly string[] = []): string {
  return key !== null && isSecretName(key) ? DOTS : mask(value, secrets);
}

/** One response header's value. A cookie the server sets keeps its name and attributes but never
 *  its value; any other header named like a secret is hidden whole. */
export function maskHeader(name: string, value: string, secrets: readonly string[] = []): string {
  if (name.toLowerCase() === "set-cookie") return mask(value, secrets).replace(/^([^=;]*)=[^;]*/, `$1=${DOTS}`);
  return SECRET_HEADER.test(name) ? DOTS : mask(value, secrets);
}
