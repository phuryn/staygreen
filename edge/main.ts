import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { EdgeCache } from "./cache";
import { config, POLL_MS } from "./config";
import { purge } from "./purge";
import { withdraw } from "./control";

const env = config(process.env);
const cache = new EdgeCache(env.EDGE_STATUS_HOST);
const pool = new Pool({ connectionString: env.EDGE_DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 20_000, query_timeout: 25_000 });
pool.on("error", () => {});
const css = readFileSync("status.css");
const icon = readFileSync("icon.svg");
const font = readFileSync("Switzer-Variable.woff2");
const widget = readFileSync("w.js");
let running = false, again = false, closed = false;
let listener: Client | null = null;

async function refresh() {
  if (closed) return;
  if (running) { again = true; return; }
  running = true;
  try {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      let after = "";
      const rows: unknown[] = [];
      for (;;) {
        const batch = (await client.query("select status_edge.pages($1,100) as entry", [after])).rows;
        rows.push(...batch.map(r => r.entry));
        if (rows.length > 10_000) throw new Error("Edge capacity exceeded");
        if (batch.length < 100) break;
        after = batch.at(-1)!.entry.snapshot.page.slug;
      }
      cache.replace(rows, Date.now());
      await client.query("commit");
    } catch { await client.query("rollback").catch(() => {}); throw new Error("refresh"); }
    finally { client.release(); }
  } catch { console.error("Edge refresh failed; retaining the last public snapshot."); }
  try { await purge(cache.pendingPurge, env.EDGE_ZONE_ID, env.EDGE_PURGE_TOKEN); }
  catch { console.error("Edge purge pending; retrying."); }
  running = false;
  if (again) { again = false; setTimeout(() => void refresh(), 500); }
}

async function listen() {
  if (closed || listener) return;
  const client = new Client({ connectionString: env.EDGE_DATABASE_URL, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  listener = client;
  const lost = () => { if (listener === client) listener = null; void client.end().catch(() => {}); };
  client.on("error", lost); client.on("end", () => { if (listener === client) listener = null; });
  client.on("notification", () => void refresh());
  try { await client.connect(); await client.query("listen status_edge_changed"); }
  catch { lost(); }
}

const server = createServer((req, res) => {
  if (req.url === "/_edge/withdraw" && req.method === "POST") {
    void withdraw(req.headers, req, env.EDGE_CONTROL_SECRET, cache,
      () => purge(cache.pendingPurge, env.EDGE_ZONE_ID, env.EDGE_PURGE_TOKEN))
      .then(status => { res.writeHead(status, { "Cache-Control": "no-store" }).end(); });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }).end(); return; }
  if (req.url === "/health") {
    const ready = cache.loaded && Date.now() - cache.refreshedAt < POLL_MS * 3 && cache.pendingPurge.size === 0;
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ ready, release: env.EDGE_RELEASE, refreshedAt: cache.refreshedAt, pendingPurge: cache.pendingPurge.size })); return;
  }
  const host = req.headers.host?.toLowerCase() ?? "";
  if (host === env.EDGE_STATUS_HOST && req.url === "/w.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" })
      .end(req.method === "HEAD" ? undefined : widget); return;
  }
  // Caddy replaces Host with the original request host; forwarded headers are never trusted.
  if (req.url === "/icon.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300", "Content-Security-Policy": "sandbox; default-src 'none'" }).end(req.method === "HEAD" ? undefined : icon); return; }
  if (req.url === "/_edge/status.css" || req.url === "/_edge/Switzer-Variable.woff2") {
    const file = req.url.endsWith(".css") ? css : font;
    res.writeHead(200, { "Content-Type": req.url.endsWith(".css") ? "text/css" : "font/woff2", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" }).end(req.method === "HEAD" ? undefined : file); return;
  }
  if (host === env.EDGE_STATUS_HOST && req.url === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }).end("User-agent: *\nDisallow: /\n"); return; }
  const response = cache.respond(host, req.url ?? "/", Date.now());
  res.writeHead(response.status, response.headers).end(req.method === "HEAD" ? undefined : response.body);
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
server.listen(7080, "127.0.0.1");
void listen().then(refresh);
const poll = setInterval(() => { void listen(); void refresh(); }, POLL_MS);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  closed = true; clearInterval(poll); server.close(); void listener?.end(); void pool.end();
});
