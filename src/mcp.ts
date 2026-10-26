import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { apiOrigin, call, ClientError, redact, type ErrorBody } from "./client";
import { inputs, isTool, LINE_LIMIT, MCP_INSTRUCTIONS, MCP_TOOLS, MCP_VERSIONS } from "./contract";
import { cliEnv } from "./env";

const idSchema = z.union([z.string().max(200), z.number().finite()]);
const rpc = z.object({ jsonrpc: z.literal("2.0"), id: idSchema.optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() }).strict();
const initialize = z.object({ protocolVersion: z.string(), capabilities: z.object({}).passthrough(), clientInfo: z.object({ name: z.string().max(160), version: z.string().max(80) }) });
const toolCall = z.object({ name: z.string().max(80), arguments: z.record(z.string(), z.unknown()).optional() }).strict();
const toolError = (body: ErrorBody) => ({ content: [{ type: "text", text: JSON.stringify(body) }], isError: true });

export type McpOptions = {
  input: Readable; output: Writable;
  origin?: string; env?: Record<string, string | undefined>; fetcher?: typeof fetch;
};

/** One newline-delimited JSON-RPC connection. There is no session or OAuth state. */
export async function serveMcp({ input, output, origin = "https://staygreen.io", env = process.env, fetcher = fetch }: McpOptions) {
  apiOrigin(origin);
  const token = cliEnv.parse(env).STAYGREEN_API_TOKEN;
  const active = new Map<string | number, { controller: AbortController; task: Promise<void> }>();
  const outputFailed = () => {
    for (const { controller } of active.values()) controller.abort();
    input.destroy();
  };
  output.on("error", outputFailed);
  const send = (message: unknown) => new Promise<void>((resolve, reject) => {
    output.write(JSON.stringify(redact(message, token)) + "\n", error => error ? reject(error) : resolve());
  });
  const rpcError = (id: string | number | null, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const reply = (id: string | number, result: unknown) => send({ jsonrpc: "2.0", id, result });

  const dispatch = async (line: Buffer) => {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { await rpcError(null, -32700, "Parse error"); return; }
    const parsed = rpc.safeParse(raw);
    if (!parsed.success) { await rpcError(null, -32600, "Invalid Request"); return; }
    const { id, method, params } = parsed.data;
    if (id === undefined) {
      if (!method.startsWith("notifications/")) { await rpcError(null, -32600, "Invalid Request"); return; }
      if (method === "notifications/cancelled") {
        const cancelled = idSchema.safeParse(params?.requestId);
        if (cancelled.success) active.get(cancelled.data)?.controller.abort();
      }
      return;
    }
    if (active.has(id)) { await rpcError(id, -32600, "Invalid Request"); return; }
    if (method === "initialize") {
      const init = initialize.safeParse(params);
      if (!init.success) { await rpcError(id, -32602, "Invalid params"); return; }
      await reply(id, { protocolVersion: MCP_VERSIONS.includes(init.data.protocolVersion) ? init.data.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "staygreen", title: "Staygreen", version: "1.0.0" }, instructions: MCP_INSTRUCTIONS }); return;
    }
    if (method === "ping") { await reply(id, {}); return; }
    if (method === "tools/list") { await reply(id, { tools: MCP_TOOLS }); return; }
    if (method !== "tools/call") { await rpcError(id, -32601, "Method not found"); return; }
    const tool = toolCall.safeParse(params);
    if (!tool.success) { await rpcError(id, -32602, "Invalid params"); return; }
    const { name, arguments: args = {} } = tool.data;
    if (!isTool(name)) { await rpcError(id, -32602, "Unknown tool"); return; }
    if (!token && name !== "scan_app") {
      await reply(id, toolError({ error: { code: "missing_token", message: "Set STAYGREEN_API_TOKEN to a workspace API token from /app/agents (https://staygreen.io/app/agents). Choose read-only or read-and-write access." } })); return;
    }
    if (!inputs[name].safeParse(args).success) {
      await reply(id, toolError({ error: { code: "invalid_arguments", message: "Check the documented inputs. Unknown fields are refused." } })); return;
    }
    // Bound concurrent fetches without serializing input: cancellation must still
    // be read while a call is pending. The workspace's server budgets still apply.
    if (active.size >= 32) {
      await reply(id, toolError({ error: { code: "rate_limited", message: "At most 32 local calls may run at once.", retry_after: 1 } })); return;
    }
    const controller = new AbortController();
    const task = (async () => {
      let result: unknown;
      try {
        // Send the original valid arguments: the REST server owns defaults and
        // refinements, and unchanged write inputs preserve retry identity.
        const data = await call(origin, name, args, token, fetcher, { signal: controller.signal });
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new ClientError({ error: { code: "invalid_response", message: "Staygreen returned an invalid result object." } });
        result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
      } catch (e) {
        result = toolError(e instanceof ClientError ? e.body : { error: { code: "temporarily_unavailable", message: "The request could not be completed. Try again later." } });
      }
      // Cancellation is a notification, not a tool failure; never reply to it or
      // send a late result for the cancelled call. Server-side writes may finish.
      if (!controller.signal.aborted) await reply(id, result);
    })();
    active.set(id, { controller, task });
    // An output failure closes the input and aborts the remaining work. Attach a
    // rejection handler immediately so a broken pipe is never an unhandled error.
    void task.catch(() => { input.destroy(); }).finally(() => { active.delete(id); });
  };

  let parts: Buffer[] = []; let length = 0; let discarding = false;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline;
        const piece = bytes.subarray(start, end);
        if (!discarding) {
          length += piece.length;
          if (length > LINE_LIMIT) {
            parts = []; length = 0; discarding = true;
            // HTTP uses 413 before RPC parsing. stdio has no HTTP status, so an
            // oversized frame maps to the hosted Invalid Request RPC envelope.
            await rpcError(null, -32600, "Invalid Request");
          } else if (piece.length) parts.push(Buffer.from(piece));
        }
        if (newline === -1) break;
        if (!discarding) await dispatch(Buffer.concat(parts, length));
        parts = []; length = 0; discarding = false; start = newline + 1;
      }
    }
    if (length && !discarding) await dispatch(Buffer.concat(parts, length));
    // Piped callers may close stdin after submitting their requests. Drain them
    // within the REST deadline; an explicitly cancelled request has no response.
    await Promise.all(Array.from(active.values(), item => item.task));
  } finally {
    for (const { controller } of active.values()) controller.abort();
    await Promise.allSettled(Array.from(active.values(), item => item.task));
    output.off("error", outputFailed);
  }
}
