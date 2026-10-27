import { describe, expect, it } from "vitest";
import { ipVersion, isLocalName, isPublicIp, isPublicIPv4, isPublicIPv6 } from "@/lib/ip";

/* Only the public internet may be checked (`AGENTS.md § 2.8`): private,
   loopback, link-local, CGNAT and reserved ranges are refused, in IPv4, in IPv6,
   and in IPv4 carried inside IPv6. Each range is pinned at both edges and just
   outside them, so an off-by-one prefix shows up as a red row. */

describe("ipVersion", () => {
  it.each([
    ["1.2.3.4", 4],
    ["255.255.255.255", 4],
    ["::1", 6],
    ["2606:4700:4700::1111", 6],
    ["::ffff:127.0.0.1", 6],
    ["fe80::1%eth0", 6],
    ["example.com", 0],
    ["1.2.3", 0],
    ["256.1.1.1", 0],
    ["01.2.3.4", 0],
    ["1.2.3.4.5", 0],
    ["0x7f.0.0.1", 0],
    ["2130706433", 0],
    ["1:2:3:4:5:6:7:8:9", 0],
    ["2001:db8::1::1", 0],
    ["[::1]", 0],
    ["", 0],
  ] as const)("%j is %i", (ip, version) => {
    expect(ipVersion(ip)).toBe(version);
  });
});

describe("IPv4", () => {
  // [first address, last address, the address just below, the address just above]
  const ranges: [string, string, string, string | null, string | null][] = [
    ["this network", "0.0.0.0", "0.255.255.255", null, "1.0.0.0"],
    ["private 10/8", "10.0.0.0", "10.255.255.255", "9.255.255.255", "11.0.0.0"],
    ["CGNAT 100.64/10", "100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0"],
    ["loopback 127/8", "127.0.0.0", "127.255.255.255", "126.255.255.255", "128.0.0.0"],
    ["link-local 169.254/16", "169.254.0.0", "169.254.255.255", "169.253.255.255", "169.255.0.0"],
    ["private 172.16/12", "172.16.0.0", "172.31.255.255", "172.15.255.255", "172.32.0.0"],
    ["IETF 192.0.0/24", "192.0.0.0", "192.0.0.255", "191.255.255.255", "192.0.1.0"],
    ["documentation 192.0.2/24", "192.0.2.0", "192.0.2.255", "192.0.1.255", "192.0.3.0"],
    ["6to4 relay 192.88.99/24", "192.88.99.0", "192.88.99.255", "192.88.98.255", "192.88.100.0"],
    ["private 192.168/16", "192.168.0.0", "192.168.255.255", "192.167.255.255", "192.169.0.0"],
    ["benchmarking 198.18/15", "198.18.0.0", "198.19.255.255", "198.17.255.255", "198.20.0.0"],
    ["documentation 198.51.100/24", "198.51.100.0", "198.51.100.255", "198.51.99.255", "198.51.101.0"],
    ["documentation 203.0.113/24", "203.0.113.0", "203.0.113.255", "203.0.112.255", "203.0.114.0"],
    ["multicast 224/4", "224.0.0.0", "239.255.255.255", "223.255.255.255", null],
    ["reserved and broadcast 240/4", "240.0.0.0", "255.255.255.255", null, null],
  ];

  it.each(ranges)("refuses %s at both edges and admits its neighbours", (_name, first, last, below, above) => {
    expect(isPublicIPv4(first)).toBe(false);
    expect(isPublicIPv4(last)).toBe(false);
    if (below) expect(isPublicIPv4(below)).toBe(true);
    if (above) expect(isPublicIPv4(above)).toBe(true);
  });

  it("refuses the cloud metadata endpoint", () => {
    expect(isPublicIPv4("169.254.169.254")).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "95.217.0.1", "142.250.74.78"])("admits the public address %s", (ip) => {
    expect(isPublicIPv4(ip)).toBe(true);
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each(["example.com", "1.2.3", "::1", "0x7f.0.0.1"])("is not a public IPv4 address: %j", (s) => {
    expect(isPublicIPv4(s)).toBe(false);
  });
});

describe("IPv6", () => {
  it.each([
    ["the unspecified address", "::"],
    ["loopback", "::1"],
    ["loopback, written out", "0:0:0:0:0:0:0:1"],
    ["link-local", "fe80::1"],
    ["link-local with a zone", "fe80::1%eth0"],
    ["link-local, upper case", "FE80::1"],
    ["unique local fc00::/7", "fc00::1"],
    ["unique local fd00::/8", "fd12:3456:789a::1"],
    ["multicast", "ff02::1"],
    ["documentation 2001:db8::/32", "2001:db8::1"],
    ["Teredo 2001::/32", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["IETF protocol assignments 2001::/23", "2001:1ff::1"],
    ["6to4 2002::/16", "2002:c000:0204::1"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["discard-only 100::/64", "100::1"],
  ])("refuses %s (%s)", (_name, ip) => {
    expect(isPublicIPv6(ip)).toBe(false);
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["2606:4700:4700::1111", "2a01:4f8:c17:1::1", "2001:4860:4860::8888", "2001:200::1"])("admits the global unicast address %s", (ip) => {
    expect(isPublicIPv6(ip)).toBe(true);
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each(["1:2:3:4:5:6:7:8:9", "2001:db8::1::1", "gggg::1", ":::1", "2606:4700:4700::1111::", "12345::1"])("is not an address: %j", (s) => {
    expect(isPublicIPv6(s)).toBe(false);
  });
});

describe("IPv4 inside IPv6 is judged as the IPv4 address it reaches", () => {
  it.each([
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.1.1",
    "::ffff:7f00:1",
    "::FFFF:7F00:0001",
    "0:0:0:0:0:ffff:100.64.0.1",
    "64:ff9b::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
  ])("refuses the mapped private address %s", (ip) => {
    expect(isPublicIPv6(ip)).toBe(false);
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["::ffff:8.8.8.8", "::ffff:0808:0808", "64:ff9b::1.1.1.1"])("admits the mapped public address %s", (ip) => {
    expect(isPublicIPv6(ip)).toBe(true);
  });

  it("refuses a mapped tail that is not an IPv4 address", () => {
    expect(isPublicIPv6("::ffff:256.0.0.1")).toBe(false);
  });
});

describe("isLocalName", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "api.localhost",
    "printer.local",
    "metadata.google.internal",
    "nas.lan",
    "router.home",
    "1.0.0.127.in-addr.arpa",
    "home.arpa",
    "site.test",
    "x.invalid",
    "www.example",
    "intranet",
  ])("treats %s as a name only this network can answer", (host) => {
    expect(isLocalName(host)).toBe(true);
  });

  it.each(["example.com", "api.askone.org", "status.staygreen.page", "localhost.example.com", "local.dev"])("treats %s as public", (host) => {
    expect(isLocalName(host)).toBe(false);
  });
});
