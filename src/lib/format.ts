// Formatting for times, durations and numbers. Times are the viewer's local time with the zone,
// because alerts are read on a phone wherever the builder is.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const time = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export const timeSec = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const zone = (t: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value ?? "";

export const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export const dayTime = (t: number, now: number) => {
  const d = new Date(t);
  const n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  const y = new Date(now - DAY);
  if (sameDay) return `Today ${time(t)}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time(t)}`;
  return `${day(t)}, ${time(t)}`;
};

export const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

export const until = (t: number, now: number) => {
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `in ${h} h ${rest} min` : `in ${h} h`;
};

export const dur = (ms: number) => {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : plural(d, "day");
};

export const ms = (v: number | null | undefined) => {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
};

export const pct = (v: number, digits = 2) => {
  if (v >= 100) return "100%";
  // Never round a bad minute up to a perfect score.
  const f = 10 ** digits;
  // toPrecision strips float noise first: 1.13 * 100 is 112.99999999999999, not 112.
  return `${(Math.floor(Number((v * f).toPrecision(15))) / f).toFixed(digits)}%`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const consts = { MIN, HOUR, DAY };
