/** New pages and demo copies share the same base and random-tail retry policy. */
export const pageSlugBase = (s: string) => s.toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "") || "status";
