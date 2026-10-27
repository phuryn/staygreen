import "./threadpool";
import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fork } from "node:child_process";
import path from "node:path";
import type { RollupRow } from "./rollup";
import { percentile } from "./rollup";
import { Probe, type ProbeStore } from "./runtime";
import { fresh, step, type Located, type MonitorState } from "./state";
import type { Report } from "./peer";
import type { Monitor } from "./store";

/* The probe-language benchmark (`decisions.md`, 2026-10-21 — Probe language): can TypeScript on
   Node sustain 75 checks/s per box with a fresh TCP connection and TLS handshake for every check?

   It runs the real probe runtime (wheel, checks, rollups, state machine) with an in-memory store,
   against an HTTPS target in a separate process, so the target's handshakes don't count against
   the probe's CPU. Each stage loads `rate × 60` monitors at a 60-second interval, so the wheel
   produces `rate` checks a second, spread across the seconds as in production.

     node probe/dist/bench.js [rates=75,150,300,600] [seconds=40]

   Reported per stage: the rate achieved, check latency, event-loop delay, and the probe's CPU
   (user + system) per check and as a share of one core. */

const certs = path.resolve(process.env.BENCH_CERTS ?? "tests/fixtures/tls");
const read = (f: string) => readFileSync(path.join(certs, f));

if (process.env.BENCH_ROLE === "target") {
  // The target: one worker per spare core, all on one port, answering a small body.
  if (cluster.isPrimary) {
    const n = Number(process.env.BENCH_TARGET_WORKERS ?? 4);
    let ready = 0;
    for (let i = 0; i < n; i++) cluster.fork().on("message", (m) => m === "ready" && ++ready === n && process.send?.({ port: Number(process.env.BENCH_PORT) }));
  } else {
    https
      .createServer({ key: read("localhost.key"), cert: read("localhost.pem") }, (_, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok","db":{"ok":true}}');
      })
      // Dual-stack: `localhost` resolves to ::1 first, and a refused ::1 would cost every check a
      // 250 ms happy-eyeballs fallback that has nothing to do with the probe.
      .listen({ port: Number(process.env.BENCH_PORT), host: "::", ipv6Only: false }, () => process.send?.("ready"));
  }
} else {
  void main();
}

const SELF = { id: "bench", location: "tor1", builderOnly: false, url: "http://127.0.0.1:0" };

class MemoryStore implements ProbeStore {
  private states = new Map<string, MonitorState>();
  constructor(private monitors: Monitor[]) {}
  async heartbeat() {}
  async leave() {}
  async liveProbes() {
    return [SELF];
  }
  async loadMonitors() {
    return this.monitors;
  }
  async flushRollups(_: RollupRow[]) {}
  async apply(r: Report) {
    // Simulate the store's reducer cost. This benchmark measures no database IO or contention.
    const next = step("http", this.states.get(r.monitorId) ?? fresh(), r.outcome).next;
    this.states.set(r.monitorId, next);
    return "written" as const;
  }
}

class BenchProbe extends Probe {
  latencies: number[] = [];
  failures = 0;
  async runCheck(m: Monitor): Promise<Located | null> {
    const r = await super.runCheck(m);
    if (!r) throw new Error("benchmark unexpectedly suppressed a check; no canary or Supabase backoff is installed here");
    this.latencies.push(r.ms);
    if (!r.ok) this.failures++;
    return r;
  }
}

async function main() {
  const rates = (process.argv[2] ?? "75,150,300,600").split(",").map(Number);
  const seconds = Number(process.argv[3] ?? 40);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const workers = Math.max(2, Math.min(8, os.cpus().length - 4));
  // `localhost` by default, so every check resolves a name as a real one does; BENCH_HOST=127.0.0.1
  // takes the resolver out of the measurement.
  const host = process.env.BENCH_HOST ?? "localhost";

  const target = fork(process.argv[1], [], { env: { ...process.env, BENCH_ROLE: "target", BENCH_PORT: String(port), BENCH_TARGET_WORKERS: String(workers) } });
  await new Promise<void>((resolve) => target.on("message", () => resolve()));
  const ca = read("ca.pem");

  console.log(
    `# probe benchmark: ${os.cpus().length} × ${os.cpus()[0].model}, ${os.platform()}, Node ${process.version}, ` +
      `UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? "4 (default)"}, target ${host} (${workers} workers)`,
  );
  console.log("rate\tachieved/s\tfailures\tp50 ms\tp95 ms\tp99 ms\tloop p99 ms\tuser ms/check\tsys ms/check\tCPU % of a core\tRSS MB");

  for (const rate of rates) {
    const monitors: Monitor[] = Array.from({ length: rate * 60 }, (_, i) => ({
      id: `mon_bench${String(i).padStart(6, "0")}`,
      workspaceId: "ws_bench",
      name: `bench ${i}`,
      type: "http",
      target: `https://${host}:${port}/health`,
      intervalSec: 60,
      config: { method: "GET", expect: "2xx", keyword: null, slowMs: 3000, timeoutSec: 15, assertions: [{ path: "$.db.ok", op: "==", value: "true" }] },
      paused: false,
      builder: false,
      headers: {},
      version: "0",
    }));
    const probe = new BenchProbe({
      self: SELF,
      secret: "bench-secret-bench-secret-bench-secret",
      store: new MemoryStore(monitors),
      port: 0,
      host: "127.0.0.1",
      checks: { allow: () => true, ca },
    });
    await probe.start();
    // Warm-up: JIT, the first handshakes.
    await new Promise((r) => setTimeout(r, 10_000));
    probe.latencies = [];
    probe.failures = 0;
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const checks0 = probe.counts.checks;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const wall = (performance.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const done = probe.counts.checks - checks0;
    loop.disable();
    await probe.stop();

    const lat = probe.latencies.sort((a, b) => a - b);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    console.log(
      [
        rate,
        (done / wall).toFixed(1),
        probe.failures,
        percentile(lat, 0.5),
        percentile(lat, 0.95),
        percentile(lat, 0.99),
        (loop.percentile(99) / 1e6).toFixed(1),
        (cpu.user / 1000 / Math.max(1, done)).toFixed(2),
        (cpu.system / 1000 / Math.max(1, done)).toFixed(2),
        ((cpuMs / (wall * 1000)) * 100).toFixed(1),
        Math.round(process.memoryUsage().rss / 1e6),
      ].join("\t"),
    );
  }
  target.kill();
  process.exit(0);
}
