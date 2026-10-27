import { beforeAll, expect, it } from "vitest";
import { clientFor, describeTarget, hex, readTarget, refusalOf } from "../support/integration";

/* RLS deny-all, proved through the key a browser would hold (`AGENTS.md § 1.4`:
   no browser ever holds a Supabase key, and if one leaked it must read nothing).

   Every table and every function PostgREST exposes is enumerated from its own
   schema cache (the OpenAPI document, which only the secret key may read), so a
   future object is probed without anyone remembering to add it. Each one is
   then read, written and called with the publishable key, by its real argument
   names, and must be refused by Postgres: SQLSTATE 42501 with Postgres's own
   message. PostgREST answers that with a 401 for the anon role.

   A 401 is not proof by itself (`docs/TESTS.md`: a gateway rejection is not a
   database denial). The gateway's 401 carries no SQLSTATE and says
   "Invalid API key"; the control below shows that shape with a key the gateway
   cannot know, and the first probe admits the real key by requiring the other
   shape before any refusal is counted. */

const target = readTarget({ publishableKey: true });

const PRODUCT_TABLES = ["apps", "component_monitors", "incident_notes", "incidents", "monitor_secrets", "monitors", "page_components", "status_pages", "workspaces"];
const PRODUCT_FUNCTIONS = [
  "ack_incident",
  "create_monitor",
  "create_status_page",
  "delete_monitor",
  "ensure_workspace",
  "new_id",
  "pause_monitor",
  "public_incident",
  "public_status_snapshot",
  "resume_monitor",
  "save_incident_note",
  "save_status_page",
  "workspace_snapshot",
];

type ArgSpec = { name: string; format: string; type: string };
type Exposed = { tables: { name: string; columns: string[]; text: string[] }[]; functions: { name: string; args: ArgSpec[] }[] };

/** PostgREST's schema cache, read with the secret key. */
async function exposedSurface(url: string, secretKey: string): Promise<Exposed> {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, { headers: { apikey: secretKey, Accept: "application/openapi+json" } });
  if (res.status !== 200) throw new Error(`OpenAPI read with the secret key answered ${res.status}`);
  const doc = (await res.json()) as {
    paths: Record<string, { post?: { parameters?: { in: string; schema?: { properties?: Record<string, { format: string; type: string }> } }[] } }>;
    definitions: Record<string, { properties?: Record<string, { format?: string }> }>;
  };
  const tables = Object.keys(doc.definitions)
    .sort()
    .map((name) => {
      const props = doc.definitions[name].properties ?? {};
      return { name, columns: Object.keys(props), text: Object.keys(props).filter((c) => props[c].format === "text") };
    });
  const functions = Object.keys(doc.paths)
    .filter((p) => p.startsWith("/rpc/"))
    .sort()
    .map((p) => {
      const body = doc.paths[p].post?.parameters?.find((x) => x.in === "body");
      const props = body?.schema?.properties ?? {};
      return { name: p.slice("/rpc/".length), args: Object.entries(props).map(([name, s]) => ({ name, format: s.format, type: s.type })) };
    });
  return { tables, functions };
}

/** A value of the argument's own type, so the call reaches the privilege check rather than a cast. */
function sample(arg: ArgSpec): unknown {
  if (arg.type === "integer" || arg.format.startsWith("int")) return 1;
  if (arg.type === "boolean") return false;
  if (arg.format === "jsonb" || arg.format === "json") return {};
  return "itest";
}

describeTarget("deny-all: the publishable key reaches Postgres and is refused everything", target, (t) => {
  const pub = clientFor(t.url, t.publishableKey!);
  let surface: Exposed;

  beforeAll(async () => {
    surface = await exposedSurface(t.url, t.secretKey);
  });

  it("holds a publishable key, not the secret one", () => {
    expect(t.publishableKey).toMatch(/^sb_publishable_/);
    expect(t.publishableKey).not.toBe(t.secretKey);
  });

  it("control: a key the gateway does not know is refused by the gateway, with no SQLSTATE", async () => {
    const stranger = clientFor(t.url, `sb_publishable_${hex(16)}`);
    const res = await stranger.from("workspaces").select("id").limit(1);
    expect(refusalOf(res)).toEqual({ status: 401, code: undefined, message: "Invalid API key" });
  });

  it("admits the publishable key: the gateway passes it and Postgres itself refuses", async () => {
    const res = await pub.from("workspaces").select("id").limit(1);
    expect(res.error?.message, "the gateway rejected the publishable key, so nothing below would reach Postgres").not.toBe("Invalid API key");
    expect(refusalOf(res)).toEqual({ status: 401, code: "42501", message: "permission denied for table workspaces" });
  });

  it("enumerates the product's tables and functions from PostgREST's schema cache", () => {
    expect(surface.tables.map((x) => x.name)).toEqual(expect.arrayContaining(PRODUCT_TABLES));
    expect(surface.functions.map((x) => x.name)).toEqual(expect.arrayContaining(PRODUCT_FUNCTIONS));
  });

  it("refuses a read of every table", async () => {
    const got = await Promise.all(surface.tables.map(async (x) => [x.name, refusalOf(await pub.from(x.name).select("*").limit(1))] as const));
    expect(Object.fromEntries(got)).toEqual(
      Object.fromEntries(surface.tables.map((x) => [x.name, { status: 401, code: "42501", message: `permission denied for table ${x.name}` }])),
    );
  });

  it("refuses an insert into every table", async () => {
    const got = await Promise.all(surface.tables.map(async (x) => [x.name, refusalOf(await pub.from(x.name).insert({}))] as const));
    expect(Object.fromEntries(got)).toEqual(
      Object.fromEntries(surface.tables.map((x) => [x.name, { status: 401, code: "42501", message: `permission denied for table ${x.name}` }])),
    );
  });

  it("refuses an update and a delete on every table", async () => {
    const got = await Promise.all(
      surface.tables.map(async (x) => {
        // A text column, so "itest" parses whatever the table's id is (a bigint id fails on the
        // value before the permission check is reached).
        const col = x.text[0] ?? x.columns[0];
        const upd = refusalOf(await pub.from(x.name).update({ [col]: "itest" }).eq(col, "itest-none"));
        const del = refusalOf(await pub.from(x.name).delete().eq(col, "itest-none"));
        return [x.name, { upd, del }] as const;
      }),
    );
    const denied = (name: string) => ({ status: 401, code: "42501", message: `permission denied for table ${name}` });
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(surface.tables.map((x) => [x.name, { upd: denied(x.name), del: denied(x.name) }])));
  });

  it("refuses a call of every function, made with its real argument names", async () => {
    const got = await Promise.all(
      surface.functions.map(async (f) => {
        const args = Object.fromEntries(f.args.map((a) => [a.name, sample(a)]));
        return [f.name, refusalOf(await pub.rpc(f.name, args))] as const;
      }),
    );
    expect(Object.fromEntries(got)).toEqual(
      Object.fromEntries(surface.functions.map((f) => [f.name, { status: 401, code: "42501", message: `permission denied for function ${f.name}` }])),
    );
  });
});
