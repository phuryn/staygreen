/* Which addresses Staygreen may check (`AGENTS.md § 2.8`): only the public
   internet. Private, loopback, link-local, CGNAT and reserved ranges are
   refused, so a monitor can never point the probes at Staygreen's own network
   or a cloud metadata endpoint.

   Pure, so the unit suite holds every range. `targets.ts` resolves names and
   asks this about each address; the probes ask again after every resolution
   (Phase 2), because a name can move. No Node imports: the add-monitor form
   runs it in the browser too. */

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 4 or 6 for an IP literal, 0 for anything else (the contract of Node's `isIP`). */
export function ipVersion(s: string): 0 | 4 | 6 {
  if (V4.test(s)) return 4;
  return s.includes(":") && v6Groups(s) ? 6 : 0;
}

/** [network address, prefix length] for the IPv4 ranges that are not public. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function inV4(ip: number, [base, bits]: [string, number]): boolean {
  const size = 2 ** (32 - bits);
  const start = v4ToInt(base);
  return ip >= start && ip < start + size;
}

export function isPublicIPv4(ip: string): boolean {
  if (ipVersion(ip) !== 4) return false;
  const n = v4ToInt(ip);
  return !V4_BLOCKED.some((range) => inV4(n, range));
}

/** The eight 16-bit groups of an IPv6 address, with an embedded IPv4 tail expanded. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(text)) return null;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (!V4.test(tail[1])) return null;
    const n = v4ToInt(tail[1]);
    text = text.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const groups = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

export function isPublicIPv6(ip: string): boolean {
  const g = ip.includes(":") ? v6Groups(ip) : null;
  if (!g) return false;
  // An IPv4 address carried inside IPv6 (mapped ::ffff:a.b.c.d, or NAT64 64:ff9b::/96) is
  // judged as the IPv4 address it reaches.
  const v4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIPv4(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIPv4(v4(g[6], g[7]));
  // Only global unicast (2000::/3) is public, less the parts of it that are not.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF protocol assignments, Teredo included
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4, which reaches an IPv4 address we can't see here
  return true;
}

export function isPublicIp(ip: string): boolean {
  return isPublicIPv4(ip) || isPublicIPv6(ip);
}

/** A name no public resolver answers for, or that always means this machine. */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || /\.(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(h) || !h.includes(".");
}
