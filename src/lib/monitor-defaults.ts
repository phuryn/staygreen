/* What a monitor gets for a setting the builder didn't type: the spec's own value, or a stand-in
   for a key an old row lacks. One place, so the form, the Vercel import, the snapshot and the
   probe can't drift apart (`docs/flows.md`: a default is only what the builder told us, a value
   the spec fixes, or empty with an example as the placeholder). */
export const monitorDefaults = {
  /** The slow threshold, for the two types that time something a builder can act on
   *  (`spec.md § 3.1`, `§ 3.8`). HTTP: low enough to catch a slow app, high enough that a serverless
   *  cold start isn't degraded. TCP: a connection and its TLS handshake are two round trips, about
   *  0.6 s to the far side of the world, so a second means the server is slow to accept. DNS
   *  times the public resolvers more than the builder's records, and SSL's handshake every six
   *  hours says nothing its expiry doesn't, so neither has one. */
  slowMs: { http: 3000, tcp: 1000 },
  /** `spec.md § 3.3`. */
  graceMin: 5,
  /** Counts only after a /start ping; an hour calls a job stuck only when it really is. */
  maxRunMin: 60,
  /** Vercel, Netlify and GitHub Actions all read a cron line in UTC. */
  tz: "UTC",
} as const;
