import { describe, expect, it } from "vitest";
import { findSupabase, isPublishableKey, mentionsSupabase, supabaseCheckOf, supabaseUrl } from "@/lib/supabase-detect";

/* Noticing a Supabase project in a site's page and scripts (`supabase-detect.ts`), and the rule
   that only its publishable key is ever kept. Every key here is made in the test: none is real. */

const REF = "abcdefghij0123456789";
const OTHER = "zyxwvutsrq9876543210";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${"S".repeat(43)}`;
const ANON = jwt({ iss: "supabase", ref: REF, role: "anon", iat: 1700000000, exp: 2000000000 });
const SERVICE = jwt({ iss: "supabase", ref: REF, role: "service_role", iat: 1700000000, exp: 2000000000 });
const PUBLISHABLE = `sb_publishable_${"A1b2".repeat(6)}`;
const SECRET = `sb_secret_${"Z9y8".repeat(8)}`;

// What a Next.js build inlines for `createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL, …)`.
const nextChunk = (url: string, key: string) =>
  `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[185],{4521:function(e,t,n){"use strict";n.d(t,{O:function(){return i}});var r=n(9201);let i=()=>(0,r.createBrowserClient)("${url}","${key}")}}]);`;
// And what Vite does for `import.meta.env.VITE_SUPABASE_*`.
const viteChunk = (url: string, key: string) => `const Ql="${url}",Xl="${key}",Zl=Hl(Ql,Xl,{auth:{persistSession:!0}});export{Zl as s};`;

describe("findSupabase", () => {
  it("finds the project and its new-style publishable key in a Next.js chunk", () => {
    expect(findSupabase([nextChunk(`https://${REF}.supabase.co`, PUBLISHABLE)])).toEqual({ ref: REF, key: PUBLISHABLE });
  });

  it("finds a legacy anonymous key in a Vite bundle", () => {
    expect(findSupabase([viteChunk(`https://${REF}.supabase.co`, ANON)])).toEqual({ ref: REF, key: ANON });
  });

  it("finds the project in the page and its key in a script read after it", () => {
    const html = `<link rel="preconnect" href="https://${REF}.supabase.co">`;
    expect(findSupabase([html])).toEqual({ ref: REF, key: null });
    expect(findSupabase([html, `var k="${PUBLISHABLE}"`])).toEqual({ ref: REF, key: PUBLISHABLE });
  });

  it("never keeps a secret key or a service-role key, even when it is the only one there", () => {
    expect(findSupabase([nextChunk(`https://${REF}.supabase.co`, SECRET)])).toEqual({ ref: REF, key: null });
    expect(findSupabase([viteChunk(`https://${REF}.supabase.co`, SERVICE)])).toEqual({ ref: REF, key: null });
    // Beside the publishable one, the publishable one is what is kept.
    expect(findSupabase([`${SECRET} ${SERVICE} https://${REF}.supabase.co ${ANON}`])).toEqual({ ref: REF, key: ANON });
  });

  it("matches a legacy key to the project it names, and takes another named project's", () => {
    const otherAnon = jwt({ iss: "supabase", ref: OTHER, role: "anon" });
    expect(findSupabase([`https://${REF}.supabase.co https://${OTHER}.supabase.co ${otherAnon}`])).toEqual({ ref: OTHER, key: otherAnon });
    // A key for a project the text never names isn't this one's.
    expect(findSupabase([`https://${REF}.supabase.co ${otherAnon}`])).toEqual({ ref: REF, key: null });
  });

  it("finds nothing without a project address of the right shape", () => {
    expect(findSupabase([PUBLISHABLE])).toBeNull();
    expect(findSupabase(["https://supabase.co", "https://short.supabase.co", `http://${REF}.supabase.co`, `https://${REF.toUpperCase()}.supabase.co`])).toBeNull();
    expect(findSupabase([`https://${REF}.supabase.com`, `https://${REF}.supabase.co.evil.example`])).toBeNull();
  });
});

describe("isPublishableKey", () => {
  it("is an sb_publishable_ key, or Supabase's own anonymous JWT for this project", () => {
    expect(isPublishableKey(PUBLISHABLE, REF)).toBe(true);
    expect(isPublishableKey(ANON, REF)).toBe(true);
  });

  it.each([
    ["a secret key", SECRET],
    ["a service-role JWT", SERVICE],
    ["another project's anonymous JWT", jwt({ iss: "supabase", ref: OTHER, role: "anon" })],
    ["an anonymous JWT not issued by Supabase", jwt({ iss: "someone", ref: REF, role: "anon" })],
    ["a JWT with no role", jwt({ iss: "supabase", ref: REF })],
    ["a token whose payload isn't JSON", `eyJhbGciOiJIUzI1NiJ9.eyJub3Q.${"S".repeat(43)}`],
    ["a publishable key with a newline in it", `${PUBLISHABLE}\nx`],
    ["nothing", ""],
  ])("is never %s", (_, key) => {
    expect(isPublishableKey(key, REF)).toBe(false);
  });
});

describe("the two checks", () => {
  it("are Auth health and Storage status on the project's own host, and only those", () => {
    expect(supabaseUrl(REF, "auth")).toBe(`https://${REF}.supabase.co/auth/v1/health`);
    expect(supabaseUrl(REF, "storage")).toBe(`https://${REF}.supabase.co/storage/v1/status`);
    expect(supabaseCheckOf(supabaseUrl(REF, "auth"))).toEqual({ ref: REF, service: "auth" });
    expect(supabaseCheckOf(supabaseUrl(REF, "storage"))).toEqual({ ref: REF, service: "storage" });
    for (const url of [`https://${REF}.supabase.co/rest/v1/`, `https://${REF}.supabase.co/auth/v1/health?x=1`, `http://${REF}.supabase.co/auth/v1/health`, `https://${REF}.supabase.co:8443/auth/v1/health`, "https://evil.example/auth/v1/health"]) {
      expect(supabaseCheckOf(url), url).toBeNull();
    }
  });

  it("are looked for in a script only when it names supabase.co", () => {
    expect(mentionsSupabase(nextChunk(`https://${REF}.supabase.co`, PUBLISHABLE))).toBe(true);
    expect(mentionsSupabase("var a=1")).toBe(false);
  });
});
