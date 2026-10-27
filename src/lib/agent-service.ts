import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { mask, snippet } from "@/checks/mask";
import { AgentError, inputs, outputs, requireAgentPermission, writeTools, type AgentPrincipal, type ToolName } from "./agent-contract";
import { agentHash } from "./api-token-crypto";
import { spendAgentBudget } from "./agent-auth";
import { seal } from "./credentials";
import { db } from "./db";
import { appNameRefusal, type DbError } from "./db-errors";
import type { Json } from "./database.types";
import { env } from "./env";
import { newHeartbeat, openHeartbeat } from "./heartbeat";
import { parseMonitorDraft, type MonitorRow } from "./monitor-input";
import { monitorDefaults } from "./monitor-defaults";
import { runTest, TEST_DEADLINE_MS } from "./monitor-test";
import { isService } from "./service-monitor";
import { headerContext } from "./seal";
import { checkTarget } from "./targets";
import { holds, locations, isLocationId } from "./plans";
import { resolveApp, resolveMonitor, resolveIncident } from "./workspace";
import { runScan } from "./scan";
import { admitScan } from "./scan-admission";

const notFound = () => new AgentError(404, "not_found", "Not found.");
function dbFailure(e: DbError, notCreated?: string[]): never {
  if (e.code === "PT404") throw notFound();
  if (e.code === "PT401") throw new AgentError(401, "invalid_token", "This API token has been revoked.");
  if (e.code === "PT403") throw new AgentError(403, "insufficient_scope", "Write access is required.");
  if (e.code === "PT409") throw new AgentError(409, "request_conflict", "That request_id was already used with different inputs.");
  if (/^(app|monitor|heartbeat|assertion|host|page|service_monitor)_limit$/.test(e.message ?? "")) throw new AgentError(409, "plan_limit", "This setup exceeds the workspace's plan. Nothing from this request was created.", undefined, { limit: e.message, not_created: notCreated ?? [] });
  const nameRefusal = appNameRefusal(e);
  if (nameRefusal) throw new AgentError(e.code === "23505" ? 409 : 400, e.code === "23505" ? "name_conflict" : "invalid_arguments", nameRefusal);
  if (e.code === "23505") throw new AgentError(409, "conflict", "The operation conflicts with existing data.");
  if (/^(22|23)/.test(e.code ?? "")) throw new AgentError(400, "invalid_arguments", "One of those values isn't allowed. Check the arguments.");
  // Connection loss (including supabase-js fetch errors without a code), resource
  // pressure and transaction races may succeed on replay. Other database errors
  // need investigation, not an instruction to repeat unchanged input forever.
  if (!e.code || /^(08|53)/.test(e.code) || ["40001", "40P01", "57014", "57P01", "57P02", "57P03", "PGRST000", "PGRST001", "PGRST002", "PGRST003"].includes(e.code)) {
    throw new AgentError(503, "temporarily_unavailable", "The operation could not be completed. Retry with the same request_id.");
  }
  throw new AgentError(500, "operation_failed", "The operation could not be completed.");
}
async function own(p: AgentPrincipal, kind: "app" | "monitor" | "incident", value: string) {
  const row = await ({ app: resolveApp, monitor: resolveMonitor, incident: resolveIncident }[kind])(value);
  if (!row || row.workspace.id !== p.workspace.id || row.workspace.clerk_org_id !== p.workspace.clerk_org_id) throw notFound();
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)])) : value;
const fingerprint = (tool: string, input: unknown) => agentHash("request", [tool, canonical(input)], env().API_TOKEN_PEPPER);
const windowDays = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
function historyWindow(p: AgentPrincipal, window: keyof typeof windowDays) {
  const days = Math.min(windowDays[window], holds(p.entitlements, "history_1y") ? 365 : 30);
  return { days, window: days === windowDays[window] ? window : "30d" };
}
/** Targets may contain legacy credentials in query parameters. Reads expose no query,
 * fragment or user-info, and heartbeat targets never become ping URLs. */
export function safeTarget(type: string, target: string) {
  if (type === "heartbeat") return "Scheduled job";
  try { const u = new URL(target); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return mask(u.href); }
  catch { return mask(target); }
}
type MonitorRead = { id: string; app_id: string; name: string; type: string; target: string; interval_sec: number; state: string | null; paused_at: string | null; paused_until: string | null; probe_outcome_at: string | null };
const MONITOR_SELECT = "id,app_id,name,type,target,interval_sec,state,paused_at,paused_until,probe_outcome_at";
function stateOf(m: MonitorRead) { return m.paused_at && (!m.paused_until || Date.parse(m.paused_until) > Date.now()) ? "paused" : m.state ?? "unchecked"; }
type CheckTime = { id: string; at: string | null; precision: "exact" | "5m_window_start" | "none" };
async function checkTimes(p: AgentPrincipal) {
  const { data, error } = await db().rpc("agent_check_times", { p_workspace_id: p.workspace.id });
  if (error) dbFailure(error);
  const rows = z.array(z.object({ id: z.string(), at: z.string().nullable(), precision: z.enum(["exact", "5m_window_start", "none"]) })).parse(data);
  return new Map(rows.map(r => [r.id, r]));
}
function monitorDto(m: MonitorRead, times: Map<string, CheckTime>) {
  const time = times.get(m.id);
  return { id: m.id, app: m.app_id, name: mask(m.name), type: m.type, target: safeTarget(m.type,m.target), interval_sec: m.interval_sec, state: stateOf(m), last_check: time?.at ?? null, last_check_precision: time?.precision ?? "none" };
}
const overall = (states: string[]) => ["down","degraded","unchecked","paused","up"].find(s => states.includes(s)) ?? "unchecked";
const place = (s: string) => isLocationId(s) ? `${locations[s].city}, ${locations[s].country}` : null;
function cursorId(cursor: string | undefined, prefix: string) {
  if (cursor && !new RegExp(`^${prefix}_[0-9a-f]{24}$`).test(cursor)) throw new AgentError(400,"invalid_cursor","Use next_cursor from the preceding page.");
  return cursor ?? null;
}
const record = (v: Json | unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
const text = (v: unknown) => typeof v === "string" ? mask(v) : null;
async function latestNotes(p: AgentPrincipal, ids: string[]) {
  if (!ids.length) return new Map();
  // One latest note per incident in SQL: a prolific incident must not fill a response
  // limit and hide the latest note of a different incident.
  const { data, error } = await db().rpc("agent_published_notes",{p_workspace_id:p.workspace.id,p_incident_ids:ids});
  if(error) dbFailure(error);
  const notes = new Map<string,{id:string;state:string;text:string;published_at:string}>();
  const rows=z.array(z.object({id:z.string(),incident_id:z.string(),state:z.string(),body:z.string(),published_at:z.string()})).parse(data);
  for(const n of rows) notes.set(n.incident_id,{id:n.id,state:n.state,text:mask(n.body),published_at:n.published_at});
  return notes;
}

const allowedConfig: Record<string, readonly string[]> = {
  http: ["method","expect","keyword","slowMs","assertions","headers"], ssl: [], tcp: ["port","tls","slowMs"], dns: ["record","expected"],
  heartbeat: ["schedule","tz","graceMin","maxRunMin","assertions"], stripe: ["key","endpoints","critical","failureThreshold","windowMin","pendingMin"], supabase: ["key","databaseRead"],
};
export function agentMonitorRow(input: z.infer<typeof inputs.create_monitor>): MonitorRow {
  if (Object.keys(input.config).some(k => !allowedConfig[input.type].includes(k))) throw new AgentError(400,"invalid_arguments","A configuration field does not belong to this monitor type.");
  const c = input.config;
  const common = { appId: input.app, name: input.name ?? "", type: input.type };
  const draft = input.type === "http" ? { ...common, url: input.target, method: "GET", expect: "2xx", slowMs: monitorDefaults.slowMs.http, assertions: [], headers: [], ...c }
    : input.type === "tcp" ? { ...common, host: input.target, tls: false, slowMs: monitorDefaults.slowMs.tcp, ...c }
    : input.type === "ssl" ? { ...common, host: input.target }
    : input.type === "dns" ? { ...common, recordName: input.target, ...c }
    : input.type === "heartbeat" ? { ...common, tz: monitorDefaults.tz, graceMin: monitorDefaults.graceMin, maxRunMin: monitorDefaults.maxRunMin, assertions: [], ...c }
    : input.type === "supabase" ? { ...common, projectUrl: input.target, ...c }
    : { ...common, ...c };
  if(input.type === "stripe" && input.target !== "https://api.stripe.com") throw new AgentError(400,"invalid_arguments","Stripe's target must be https://api.stripe.com.");
  const parsed = parseMonitorDraft(draft);
  if (!parsed.ok) throw new AgentError(400,"invalid_arguments","Check the monitor's type, target and required settings.",undefined,{fields:Object.keys(parsed.fieldErrors)});
  // Both agent tools cap HTTP(S) URL hosts before budgets or writes: HTTPS can
  // create an automatic SSL monitor named after its host (80 characters max).
  // Other monitor types do not create that URL-derived automatic SSL monitor.
  if (parsed.row.type === "http" && (parsed.row.targetHost?.length ?? 0) > 80) {
    throw new AgentError(400,"invalid_arguments","Use a URL whose hostname is at most 80 characters.");
  }
  return parsed.row;
}
export function normalizeAppUrl(url: string) {
  let u: URL; try { u = new URL(url); } catch { throw new AgentError(400,"invalid_arguments","Use a public HTTP or HTTPS address."); }
  if(!["http:","https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new AgentError(400,"invalid_arguments","Use an HTTP(S) address without credentials, query parameters or a fragment.");
  u.hostname = u.hostname.replace(/\.$/,"");
  return u.href.replace(/\/$/,"");
}
async function prepareMonitor(p: AgentPrincipal, row: MonitorRow, test = false) {
  const id = `mon_${randomBytes(12).toString("hex")}`;
  if(row.targetHost && ["http","tcp","ssl","supabase"].includes(row.type)) {
    const checked = await checkTarget(row.targetHost);
    if(!checked.ok) throw new AgentError(400,"private_target","The target must resolve only to public internet addresses.");
  }
  const heartbeat = row.type === "heartbeat" ? await newHeartbeat(id) : null;
  const L = p.entitlements.limits;
  const first = { status: "awaiting_ping" as "awaiting_ping" | "passed" | "failed", checked_at: null as string | null, message: null as string | null };
  if(row.type !== "heartbeat" && (test || isService(row.type))) {
    const outcome = await runTest(row,Object.fromEntries(row.secrets.map(s=>[s.name,s.value])),TEST_DEADLINE_MS);
    if(isService(row.type) && (!("service" in outcome) || !outcome.service.saveable)) throw new AgentError(400,"verification_failed","The service configuration could not be verified. Check its read-only key and settings.");
    first.status = outcome.ok ? "passed" : "failed";
    first.checked_at = new Date(outcome.at).toISOString();
    first.message = outcome.failure ? mask(outcome.failure.message,row.secrets.map(s=>s.value)) : null;
  }
  return { row: { id, type: row.type, name: row.name, target: row.target, target_host: row.targetHost,
    config: row.config, interval_sec: row.fixedIntervalSec ?? (row.type === "stripe" ? L.stripePollMin : L.httpIntervalMin)*60,
    secrets: row.secrets.map(s=>({name:s.name,sealed:seal(s.value,headerContext(id,s.name))})),
    service_sealed: isService(row.type) ? seal(row.secrets[0].value,headerContext(id,row.secrets[0].name)) : null,
    heartbeat_hash: heartbeat?.hash ?? null, heartbeat_sealed: heartbeat?.sealed ?? null }, first };
}
async function write(p: AgentPrincipal, tool: ToolName, raw: unknown): Promise<unknown> {
  requireAgentPermission(p, tool === "draft_incident_update" ? "incidents:draft" : "monitors:write");
  const input = inputs[tool].parse(raw) as {request_id:string};
  const hash = fingerprint(tool,input);
  const prior = await db().from("agent_requests").select("input_hash,tool,result").eq("workspace_id",p.workspace.id).eq("actor",p.actor).eq("request_id",input.request_id).maybeSingle();
  if(prior.error) dbFailure(prior.error);
  if(prior.data) {
    if(prior.data.input_hash !== hash || prior.data.tool !== tool) throw new AgentError(409,"request_conflict","That request_id was already used with different inputs.");
    return writeResult(tool,prior.data.result);
  }
  let payload: unknown; let notCreated: string[] = [];
  const budget = () => spendAgentBudget(agentHash("network-tests",p.workspace.id,env().API_TOKEN_PEPPER),6);
  if(tool === "create_monitor") {
    const a = inputs.create_monitor.parse(input);
    await own(p,"app",a.app);
    const row = agentMonitorRow(a);
    await budget();
    const prepared = await prepareMonitor(p,row,true);
    payload = {app:a.app,monitor:prepared.row,first_check:prepared.first}; notCreated = [row.type];
  } else if(tool === "provision_app") {
    const a = inputs.provision_app.parse(input); const url = normalizeAppUrl(a.url);
    // URL parsing and address refusal happen even for an existing app.
    const appId = `app_${"0".repeat(24)}`;
    const drafts = [agentMonitorRow({ request_id:a.request_id,app:appId,type:"http",target:url,config:{},name:"Website" })];
    const skipped: {item:string;reason:string}[] = [];
    for(const cron of a.crons_from ?? []) drafts.push(agentMonitorRow({request_id:a.request_id,app:appId,type:"heartbeat",name:cron.name,target:cron.name,config:{schedule:cron.schedule,tz:cron.tz}}));
    if(a.supabase_url && a.supabase_key) drafts.push(agentMonitorRow({request_id:a.request_id,app:appId,type:"supabase",target:a.supabase_url,config:{key:a.supabase_key}}));
    else if(a.supabase_url || a.supabase_key) skipped.push({item:"supabase",reason:"Provide both supabase_url and its publishable key to create the health check."});
    if(a.stripe_key && a.stripe_endpoints?.length) drafts.push(agentMonitorRow({request_id:a.request_id,app:appId,type:"stripe",target:"https://api.stripe.com",config:{key:a.stripe_key,endpoints:a.stripe_endpoints}}));
    else if(a.stripe_key || a.stripe_endpoints) skipped.push({item:"stripe",reason:"Provide both a restricted key and the webhook endpoint ids to watch."});
    if(a.mcp_url) skipped.push({item:"mcp",reason:"MCP server monitors are Coming soon."});
    if(a.status_domain) skipped.push({item:"status_domain",reason:"Custom-domain setup belongs to the separate status-edge stage. The standard status page is available."});
    await budget();
    const prepared = await Promise.all(drafts.map(row=>prepareMonitor(p,row)));
    // The transaction chooses an unused default while holding the workspace lock.
    // An explicit name stays exact so a collision is a refusal, not a silent rename.
    payload = { url,name:a.name ?? null,name_base:new URL(url).hostname,slug:`app-${randomBytes(12).toString("hex")}`,monitors:prepared.map(x=>x.row),skipped };
    notCreated = ["app","status page",...drafts.map(r=>r.type)];
  } else if(tool === "pause") {
    const a = inputs.pause.parse(input);
    if(a.app) await own(p,"app",a.app); else await own(p,"monitor",a.monitor!);
    payload = a;
  } else {
    const a = inputs.draft_incident_update.parse(input); await own(p,"incident",a.incident); payload = a;
  }
  const L = p.entitlements.limits;
  const {data,error} = await db().rpc("agent_write",{p_workspace_id:p.workspace.id,p_actor:p.actor,p_client:p.client,p_scope:p.scope,p_tool:tool,p_request_id:input.request_id,p_input_hash:hash,p_payload:payload as Json,
    p_limits:{...L,perHost:L.perHost === "fair use" ? L.monitors : L.perHost,supabaseMonitors:L.supabaseMonitors === "cap" ? L.monitors : L.supabaseMonitors,minInterval:L.httpIntervalMin*60} as Json});
  if(error) dbFailure(error,notCreated);
  return writeResult(tool,data);
}
function writeResult(tool: ToolName, raw: Json): unknown {
  const r = record(raw);
  if(tool === "draft_incident_update") return {draft:r.draft,approval_url:new URL(`/app/incidents/${r.incident}`,env().APP_URL).href,published:false};
  if(tool !== "provision_app") return r;
  const receipt = z.object({app:z.string(),created:z.boolean(),monitors:z.array(z.object({id:z.string(),name:z.string(),type:z.string()})),heartbeats:z.array(z.object({monitor:z.string(),name:z.string(),sealed:z.string()})),slug:z.string(),skipped:z.array(z.object({item:z.string(),reason:z.string()}))}).parse(r);
  return {...receipt,slug:undefined,monitors:receipt.monitors.map(m=>({...m,name:mask(m.name)})),heartbeats:receipt.heartbeats.map(h=>{
    const url = openHeartbeat(h.sealed,h.monitor); if(!url) throw new AgentError(503,"temporarily_unavailable","A created heartbeat credential could not be opened. Try again later.");
    return {monitor:h.monitor,name:mask(h.name),url};
  }),status_page_url:new URL(`/s/${receipt.slug}`,env().APP_URL).href,cname:null};
}

export async function executeAgentTool(p: AgentPrincipal, tool: ToolName, raw: unknown): Promise<Record<string,unknown>> {
  requireAgentPermission(p,"monitors:read");
  const input = inputs[tool].parse(raw);
  let result: unknown;
  if(writeTools.includes(tool)) result = await write(p,tool,input);
  else if(tool === "scan_app") {
    await admitScan("agent", `${p.workspace.id}:${p.actor}`);
    result = await runScan(inputs.scan_app.parse(input));
  }
  else if(tool === "list_monitors") {
    const a = inputs.list_monitors.parse(input); if(a.app) await own(p,"app",a.app);
    let q = db().from("monitors").select(MONITOR_SELECT).eq("workspace_id",p.workspace.id).order("id");
    if(a.app) q=q.eq("app_id",a.app); if(a.type) q=q.eq("type",a.type);
    // Read the bounded workspace (100 configurable monitors plus automatic SSL monitors)
    // before the state filter, so an expired pause has the same semantics as the dashboard.
    const {data,error}=await q.limit(1000); if(error) dbFailure(error);
    const times = await checkTimes(p);
    const after=cursorId(a.cursor,"mon"); const all=(data??[]).map(m => monitorDto(m, times)).filter(m=>(!a.status||m.state===a.status)&&(!after||m.id>after));
    result={monitors:all.slice(0,a.limit),next_cursor:all.length>a.limit?all[a.limit-1].id:null};
  } else if(tool === "get_status") {
    const a=inputs.get_status.parse(input); if(a.app!=="*") await own(p,"app",a.app);
    const ws=p.workspace.id;
    const [apps,mons,components,bindings,pages,incidents]=await Promise.all([
      db().from("apps").select("id,name").eq("workspace_id",ws).order("id"),
      db().from("monitors").select(MONITOR_SELECT).eq("workspace_id",ws).order("id").limit(1000),
      db().from("page_components").select("id,page_id,name,in_app").eq("workspace_id",ws).order("position").limit(1000),
      db().from("component_monitors").select("component_id,monitor_id").eq("workspace_id",ws).limit(10000),
      db().from("status_pages").select("id,app_id").eq("workspace_id",ws),
      db().from("incidents").select("id,monitor_id,title,opened_at").eq("workspace_id",ws).is("resolved_at",null).order("opened_at",{ascending:false}).limit(1000),
    ]);
    for(const r of [apps,mons,components,bindings,pages,incidents]) if(r.error) dbFailure(r.error);
    const notes=await latestNotes(p,(incidents.data??[]).map(i=>i.id));
    const times = await checkTimes(p);
    const ms=(mons.data??[]).map(m => monitorDto(m, times));
    result={apps:(apps.data??[]).filter(x=>a.app==="*"||x.id===a.app).map(x=>{
      const mon=ms.filter(m=>m.app===x.id);const ids=new Set(mon.map(m=>m.id));const pageIds=new Set((pages.data??[]).filter(y=>y.app_id===x.id).map(y=>y.id));
      return {id:x.id,name:mask(x.name),state:overall(mon.map(m=>m.state)),monitors:mon,
        components:(components.data??[]).filter(c=>pageIds.has(c.page_id)).map(c=>{
          const bound=(bindings.data??[]).filter(b=>b.component_id===c.id).map(b=>b.monitor_id);
          return {id:c.id,name:mask(c.name),in_app:c.in_app,monitors:bound,state:overall(ms.filter(m=>bound.includes(m.id)).map(m=>m.state))};
        }),incidents:(incidents.data??[]).filter(i=>ids.has(i.monitor_id)).map(i=>({id:i.id,title:mask(i.title),monitor:i.monitor_id,opened_at:i.opened_at,latest_note:notes.get(i.id)??null}))};
    })};
  } else if(tool === "get_uptime") {
    // The type generator marks every SQL argument non-null; 030's readers take null for the first
    // page and for every location.
    const a=inputs.get_uptime.parse(input); const w=historyWindow(p,a.window); const after=cursorId(a.cursor,"mon");
    if(a.monitor!=="*") await own(p,"monitor",a.monitor);
    const {data,error}=await db().rpc("agent_history",{p_workspace_id:p.workspace.id,p_monitor_id:a.monitor,p_days:w.days,p_limit:a.limit,p_after:after as string});if(error) dbFailure(error);
    const rows=z.array(outputs.get_uptime.shape.monitors.element).parse(data);
    result={window:w.window,monitors:rows.slice(0,a.limit),next_cursor:rows.length>a.limit?rows[a.limit-1].id:null};
  } else if(tool === "get_response_times") {
    const a=inputs.get_response_times.parse(input);await own(p,"monitor",a.monitor);const w=historyWindow(p,a.window);
    if(a.cursor && !/^\d{1,6}$/.test(a.cursor)) throw new AgentError(400,"invalid_cursor","Use next_cursor from the preceding page.");
    const offset=Number(a.cursor??0);if(offset>100000) throw new AgentError(400,"invalid_cursor","That cursor is out of range.");
    const location=Object.entries(locations).find(([,v])=>`${v.city}, ${v.country}`===a.location)?.[0]??null;
    const {data,error}=await db().rpc("agent_response_times",{p_workspace_id:p.workspace.id,p_monitor_id:a.monitor,p_days:w.days,p_location:location as string,p_offset:offset,p_limit:a.limit});if(error) dbFailure(error);
    const rows=z.array(z.object({at:z.string(),location:z.string(),p50_ms:z.number().nullable(),p95_ms:z.number().nullable()})).parse(data);
    result={monitor:a.monitor,window:w.window,resolution:w.days===1?"5m":w.days<=30?"1h":"1d",aggregation:"maximum of stored window percentiles",series:rows.slice(0,a.limit).flatMap(r=>place(r.location)?[{...r,location:place(r.location)}]:[]),next_cursor:rows.length>a.limit?String(offset+a.limit):null};
  } else if(tool === "get_incidents") {
    const a=inputs.get_incidents.parse(input);if(a.app) await own(p,"app",a.app);const after=cursorId(a.cursor,"inc");
    const ms=await db().from("monitors").select("id,app_id").eq("workspace_id",p.workspace.id).limit(1000);if(ms.error) dbFailure(ms.error);
    const mon=(ms.data??[]).filter(m=>!a.app||m.app_id===a.app);const ids=mon.map(m=>m.id);
    if(!ids.length) result={incidents:[],next_cursor:null};
    else {
      const earliest=Date.now()-(holds(p.entitlements,"history_1y")?365:30)*86400000;
      let q=db().from("incidents").select("id,monitor_id,title,opened_at,resolved_at,evidence,timeline").eq("workspace_id",p.workspace.id).in("monitor_id",ids).gte("opened_at",new Date(Math.max(earliest,a.since?Date.parse(a.since):earliest)).toISOString()).order("id").limit(a.limit+1);
      if(after) q=q.gt("id",after);if(a.state==="open") q=q.is("resolved_at",null);if(a.state==="resolved") q=q.not("resolved_at","is",null);
      const {data,error}=await q;if(error) dbFailure(error);const rows=(data??[]).slice(0,a.limit);const notes=await latestNotes(p,rows.map(i=>i.id));
      result={incidents:rows.map(i=>{
        const e=record(i.evidence);return {id:i.id,app:mon.find(m=>m.id===i.monitor_id)!.app_id,monitor:i.monitor_id,title:mask(i.title),opened_at:i.opened_at,resolved_at:i.resolved_at,
          timeline:(Array.isArray(i.timeline)?i.timeline:[]).map(record).flatMap(t=>typeof t.t==="string"&&typeof t.text==="string"?[{at:t.t,text:mask(t.text)}]:[]),
          locations:(Array.isArray(e.locations)?e.locations:[]).flatMap(l=>typeof l==="string"&&place(l)?[place(l)]:[]),assertion:text(e.assertion),snippet:typeof e.snippet==="string"?snippet(e.snippet):null,latest_note:notes.get(i.id)??null};
      }),next_cursor:(data??[]).length>a.limit?rows[rows.length-1].id:null};
    }
  } else {
    const a=inputs.get_ssl_and_domain_expiry.parse(input);if(a.app) await own(p,"app",a.app);const after=cursorId(a.cursor,"mon");
    let q=db().from("monitors").select("id,target_host,cert_host,cert_expires_at").eq("workspace_id",p.workspace.id).eq("type","ssl").order("id").limit(a.limit+1);
    if(a.app) q=q.eq("app_id",a.app);if(after) q=q.gt("id",after);
    const [r,domains]=await Promise.all([q,db().rpc("workspace_domains",{p_workspace_id:p.workspace.id})]);if(r.error) dbFailure(r.error);if(domains.error) dbFailure(domains.error);
    const rows=(r.data??[]).slice(0,a.limit);const days=(s:string|null)=>s?Math.floor((Date.parse(s)-Date.now())/86400000):null;
    result={hosts:rows.map(m=>{const cert=m.cert_host===m.target_host?m.cert_expires_at:null;const domain=domains.data?.find(d=>d.host===m.target_host);const expiry=domain?.status==="found"?domain.expires_at:null;return {monitor:m.id,host:mask(m.target_host??""),certificate_expires_at:cert,certificate_days_left:days(cert),domain_expires_at:expiry??null,domain_days_left:days(expiry??null)};}),next_cursor:(r.data??[]).length>a.limit?rows[rows.length-1].id:null};
  }
  // Every success is reduced to its declared output schema. Raw rows and future columns
  // cannot accidentally widen either transport's response.
  return outputs[tool].parse(result);
}
