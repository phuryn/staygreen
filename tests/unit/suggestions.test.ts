import { describe, expect, it } from "vitest";
import { HEALTH_PATHS, rootName, sslComesWith, suggestionTargets } from "@/lib/suggestions";

/* Which addresses a suggestion run tries for an app's address, and when its SSL check comes free
   with an HTTPS one (`docs/flows.md § Suggested checks`). The browser and the server both read
   these, so the screen's ticks and what `addSuggestedChecks` adds agree. */

describe("suggestionTargets", () => {
  it("tries the address, fifteen health routes on its origin, and the host's certificate", () => {
    expect(suggestionTargets("https://afkpilot.com/")).toEqual({
      address: "https://afkpilot.com/",
      origin: "https://afkpilot.com",
      health: [
        { url: "https://afkpilot.com/health", name: "Health check" },
        { url: "https://afkpilot.com/healthz", name: "Health check (healthz)" },
        { url: "https://afkpilot.com/api/health", name: "API health" },
        { url: "https://afkpilot.com/api/healthz", name: "API health (healthz)" },
        { url: "https://afkpilot.com/status", name: "Status endpoint" },
        { url: "https://afkpilot.com/up", name: "Health check (up)" },
        { url: "https://afkpilot.com/readyz", name: "Readiness check" },
        { url: "https://afkpilot.com/livez", name: "Liveness check" },
        { url: "https://afkpilot.com/actuator/health", name: "Spring Boot health" },
        { url: "https://afkpilot.com/ping", name: "Ping" },
        { url: "https://afkpilot.com/healthcheck", name: "Health check (healthcheck)" },
        { url: "https://afkpilot.com/version", name: "Version endpoint" },
        { url: "https://afkpilot.com/_health", name: "Health check (_health)" },
        { url: "https://afkpilot.com/api/status", name: "API status" },
        { url: "https://afkpilot.com/api/version", name: "API version" },
      ],
      sslHost: "afkpilot.com",
    });
    expect(HEALTH_PATHS).toHaveLength(15);
  });

  it("tries health routes at the origin whatever path the address has, and never the address twice", () => {
    const t = suggestionTargets("https://example.com/api/health")!;
    expect(t.address).toBe("https://example.com/api/health");
    expect(t.health.map((h) => h.url)).toEqual([
      "https://example.com/health",
      "https://example.com/healthz",
      "https://example.com/api/healthz",
      "https://example.com/status",
      "https://example.com/up",
      "https://example.com/readyz",
      "https://example.com/livez",
      "https://example.com/actuator/health",
      "https://example.com/ping",
      "https://example.com/healthcheck",
      "https://example.com/version",
      "https://example.com/_health",
      "https://example.com/api/status",
      "https://example.com/api/version",
    ]);
  });

  it("gives an SSL check only to a named host on 443, as `create_monitor` does", () => {
    expect(suggestionTargets("http://example.com/")!.sslHost).toBe("example.com");
    expect(suggestionTargets("https://Example.COM./")!.sslHost).toBe("example.com");
    expect(suggestionTargets("https://example.com:8443/")!.sslHost).toBeNull();
    expect(suggestionTargets("https://93.184.216.34/")!.sslHost).toBeNull();
    expect(suggestionTargets("https://[2606:2800:220:1::]/")!.sslHost).toBeNull();
    // A written :443 is the default port, which `URL` drops.
    expect(suggestionTargets("https://example.com:443/")!.sslHost).toBe("example.com");
  });

  it("tries nothing for an address that isn't http or https", () => {
    for (const a of ["", "example.com", "ftp://example.com/", "javascript:alert(1)", "mailto:a@example.com"]) expect(suggestionTargets(a), a).toBeNull();
  });

  it("names the address's check as the add form would", () => {
    expect(rootName("https://afkpilot.com/")).toBe("Website");
    expect(rootName("https://afkpilot.com/app/sign-in")).toBe("Sign in");
  });
});

describe("sslComesWith", () => {
  it("is true for an HTTPS check on the same named host without a port", () => {
    expect(sslComesWith(["https://afkpilot.com/"], "afkpilot.com")).toBe(true);
    expect(sslComesWith(["https://AFKPILOT.com/health"], "afkpilot.com")).toBe(true);
  });

  it("is false for plain HTTP, another host, a port of its own, nothing ticked, or no SSL host", () => {
    expect(sslComesWith(["http://afkpilot.com/"], "afkpilot.com")).toBe(false);
    expect(sslComesWith(["https://www.afkpilot.com/"], "afkpilot.com")).toBe(false);
    expect(sslComesWith(["https://afkpilot.com:8443/"], "afkpilot.com")).toBe(false);
    expect(sslComesWith([], "afkpilot.com")).toBe(false);
    expect(sslComesWith(["https://afkpilot.com/"], null)).toBe(false);
    expect(sslComesWith(["not a url"], "afkpilot.com")).toBe(false);
  });
});
