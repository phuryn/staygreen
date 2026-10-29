# Environment reference

Generated from the app, probe, edge, sender, watchdog and CLI Zod schemas, exported code reads, and the reviewed .env.example projection. Values below are descriptions only. Private machine-provisioning inputs are not part of this distribution. Requiredness is service-specific: running only the app does not require a probe's credentials.

Keep secrets in each service's secret store. NEXT_PUBLIC_ values are embedded in browser code. The app refuses partial configuration; email fields are all-or-none, Slack fields are paired, and enabling the status edge requires its control secret. The sender requires both Postmark and Telegram even though the app can leave these features off. CLERK_WEBHOOK_SECRET and SENTRY_DSN are reserved and do not wire integrations by themselves.

| Variable / binding | Service | Required or optional | Purpose | Value source |
|---|---|---|---|---|
| `ALERT_LINK_SECRET` | app, sender Worker, configuration sample | app: optional / defaulted; sender Worker: required | Signs alert links; shared by app and sender. Generate 32 random bytes encoded as base64url and keep stable. | Your secret generator |
| `ANTHROPIC_API_KEY` | app, configuration sample | app: optional / defaulted | Optional model-assisted scan suggestions; deterministic discovery works without it. | Your Anthropic API console |
| `API_TOKEN_PEPPER` | app, configuration sample | app: required | HMAC key for workspace API tokens and admission fingerprints; 32 random base64url bytes. Rotation invalidates tokens. | Your secret generator |
| `APP_URL` | app, edge, sender Worker, app / build, configuration sample | app: required; edge: required; sender Worker: required | Public HTTPS origin used for links, OAuth resource and alert links; localhost HTTP for development. | Your app host and DNS |
| `BENCH_CERTS` | probe | Optional / tool-managed | Directory with benchmark-only TLS fixtures. | Local benchmark setup |
| `BENCH_HOST` | probe | Optional / tool-managed | Benchmark target host; defaults to localhost. | Local benchmark setup |
| `BENCH_PORT` | probe | Optional / tool-managed | Port passed to benchmark target child processes. | Benchmark runner |
| `BENCH_ROLE` | probe | Optional / tool-managed | Internal benchmark child mode; target starts the fixture server. | Benchmark runner |
| `BENCH_TARGET_WORKERS` | probe | Optional / tool-managed | Number of benchmark target workers. | Benchmark runner |
| `CLERK_PUBLISHABLE_KEY` | tests | Optional / tool-managed | Testing SDK alias populated from the app publishable key. | Browser test setup |
| `CLERK_SECRET_KEY` | app, sender Worker, tests, configuration sample | app: required; sender Worker: required | Server-side Clerk API credential; never a public variable. | Your Clerk instance API keys |
| `CLERK_WEBHOOK_SECRET` | app, configuration sample | app: optional / defaulted | Reserved signing secret; no Clerk deletion webhook handler is implemented yet. | Leave unset until a handler is implemented |
| `CREDENTIALS_KEY` | app, probe, sender Worker, configuration sample | app: required; probe: required; sender Worker: required | AES-256-GCM key for customer credentials; 32 random base64url bytes shared with probes and sender. Back up securely. | Your secret generator |
| `DATABASE_URL` | probe, configuration sample | probe: required | Probe Postgres connection using a dedicated login with only the probe role. | Your database administrator |
| `DEV_PLAN_OVERRIDE` | app, app / build, configuration sample | app: optional / defaulted | Enables the development-only plan simulation when set to on; ignored in production and when SELF_HOSTED_PLAN=builder. | Local development preference |
| `E2E_PORT` | tests | Optional / tool-managed | Local browser-test server port. | Test runner; default 3101 |
| `EDGE_CONTROL_SECRET` | app, edge, configuration sample | app: optional / defaulted; edge: required | 32 random base64url bytes authenticating app-to-edge control requests. | Your secret generator; same value on app and edge |
| `EDGE_DATABASE_URL` | edge, configuration sample | edge: required | Postgres connection for the edge's restricted login. | Your database administrator |
| `EDGE_PURGE_TOKEN` | edge, configuration sample | edge: required | Cloudflare token limited to cache purges for your status zone. | Your Cloudflare token settings |
| `EDGE_RELEASE` | edge, configuration sample | edge: required | SHA-256 release identifier for the edge bundle and assets. | Your build pipeline |
| `EDGE_STATUS_HOST` | edge, configuration sample | edge: optional / defaulted | Your status renderer hostname. Override the hosted-service default. | Your DNS configuration |
| `EDGE_ZONE_ID` | edge, configuration sample | edge: required | Cloudflare zone identifier used to purge status content. | Your Cloudflare zone |
| `EMAIL_FROM` | app, sender Worker, configuration sample | app: optional / defaulted; sender Worker: required | Verified sender address, optionally with a display name. | Your Postmark sender configuration |
| `EMAIL_REDIRECT_TO` | app, sender Worker, configuration sample | app: optional / defaulted; sender Worker: optional / defaulted | When set, every email the app and the alert sender send goes to this one address instead of its recipient, in any environment. For development and test deployments; leave it unset in production. | Your disposable test mailbox |
| `FIRST_DATA_TIMING` | tests | Optional / tool-managed | Opt-in timing measurements in first-data integration tests. | Local test invocation |
| `HEARTBEAT_HOST` | app, configuration sample | app: required | Heartbeat receiver hostname, without scheme or path; a localhost port is allowed for development. | Your ingest Worker domain |
| `HEARTBEAT_TOKEN_KEY` | app, ingest Worker, configuration sample | app: required; ingest Worker: required | 32 random base64url bytes; same token-signing key on app and ingest. | Your secret generator |
| `HYPERDRIVE` | ingest Worker, sender Worker, watchdog Worker, ingest / sender / watchdog Workers | Required binding | Object binding providing connectionString; each Worker needs its own uncached configuration and least-privilege login. | Cloudflare Hyperdrive binding |
| `LIVE_REPORT` | tests | Optional / tool-managed | Optional destination for live suggestion-test output. | Local test invocation |
| `LIVE_SITES` | tests | Optional / tool-managed | Optional site-list input for network tests. | Local test invocation |
| `NEXT_DIST_DIR` | app / build | Optional / tool-managed | Next build directory override, used to isolate browser tests. | Build/test runner |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID` | app, app browser, configuration sample | app: optional / defaulted; app browser: optional / defaulted | Optional analytics project; absence loads no script. Configure cookieless operation. | Your Microsoft Clarity project |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | app, app browser, tests, configuration sample | app: required; app browser: required | Browser-safe Clerk publishable key for the same instance as the secret key. | Your Clerk instance API keys |
| `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL` | app, app browser, app / build, configuration sample | app: optional / defaulted; app browser: optional / defaulted | Public contact address shown on legal pages. | Your deployment operator |
| `NEXT_PUBLIC_STATUS_HOST` | app, app browser, app / build, configuration sample | app: optional / defaulted; app browser: optional / defaulted | Browser-visible status host; override the hosted-service default. | Your DNS configuration |
| `NODE_ENV` | app / build | Optional / tool-managed | Node/Next mode; controls development-only behavior. | Framework runner |
| `NODE_OPTIONS` | app / build | Optional / tool-managed | Node runtime flags, including compatibility flags in test runners. | Runtime/test runner |
| `PATH` | CLI | Optional / tool-managed | Executable search path inherited by CLI child-process tests. | Operating system |
| `POSTMARK_SERVER_TOKEN` | app, sender Worker, configuration sample | app: optional / defaulted; sender Worker: required | Postmark server credential. App email requires the token, sender and link secret together. | Your Postmark server API settings |
| `PROBE_BUILDER_ONLY` | probe, configuration sample | probe: optional / defaulted | Whether this probe only schedules paid-plan work; required true for fra1. | Your fleet configuration |
| `PROBE_DATABASE_URL` | tests, configuration sample | Optional / tool-managed | Local disposable Postgres connection for integration fixtures; guarded against remote targets. | Your local test database |
| `PROBE_ID` | probe, configuration sample | probe: required | Unique stable probe id; lowercase letters, digits and hyphens. | Your fleet configuration |
| `PROBE_LOCATION` | probe, configuration sample | probe: required | Scheduler location id: tor1, sfo3 or fra1. These are code identifiers; adapt the location model when choosing regions. | Your fleet configuration and src/lib/plans.ts |
| `PROBE_PEER_SECRET` | probe, configuration sample | probe: required | Shared HMAC secret of at least 32 characters for signed peer traffic. | Your secret generator |
| `PROBE_PORT` | probe, configuration sample | probe: optional / defaulted | Probe peer HTTP port; default 7070. | Your service configuration |
| `PROBE_RELEASE` | probe, configuration sample | probe: required | SHA-256 identifier of the deployed probe bundle. | Your build pipeline |
| `PROBE_URL` | probe, configuration sample | probe: required | Reachable peer HTTP(S) origin, without credentials, query or path. | Your private fleet network |
| `PROBE_WORKSPACES` | probe, configuration sample | probe: optional / defaulted | Optional comma-separated workspace-id filter for isolated development probes; empty checks all eligible workspaces. | Your development data setup |
| `RDAP_LIVE` | tests | Optional / tool-managed | Opt-in network-backed RDAP tests; leave unset for the offline unit run. | Local test invocation |
| `SELF_HOSTED_PLAN` | app, app / build, configuration sample | app: optional / defaulted | Optional builder grants all workspaces every Builder feature at Builder limits without Clerk Billing or Stripe. Empty uses Clerk Billing; refused when APP_URL names staygreen.io or a subdomain. Overrides the development simulation. | Your installation preference, on the app only |
| `SENTRY_DSN` | app, configuration sample | app: optional / defaulted | Reserved configuration; error reporting is not wired by setting it. | Leave unset until implemented |
| `SLACK_CLIENT_ID` | app, configuration sample | app: optional / defaulted | Optional Slack OAuth app identifier; set together with its secret. | Your Slack app settings |
| `SLACK_CLIENT_SECRET` | app, configuration sample | app: optional / defaulted | Optional Slack OAuth app secret. | Your Slack app settings |
| `STATUS_DOMAIN_SUFFIX` | app, tests, configuration sample | app: optional / defaulted | DNS suffix for claim-specific custom-domain targets; override the hosted-service default. | Your DNS configuration |
| `STATUS_EDGE_ENABLED` | app, app / build, configuration sample | app: optional / defaulted | Set on only after the status renderer, DNS and purge/control paths work. | Your deployment rollout |
| `STAYGREEN_API_TOKEN` | CLI, configuration sample | CLI: optional / defaulted | Optional CLI workspace token; without it only public scan is available. Required for authenticated tools. | Your deployment's Agents and API screen |
| `SUPABASE_PUBLISHABLE_KEY` | tests, configuration sample | Optional / tool-managed | Test-only key used to prove browser roles cannot access database objects; never needed by the app browser. | Your disposable Supabase project's API settings |
| `SUPABASE_SECRET_KEY` | app, tests, configuration sample | app: required | Server-only Supabase key; never expose to a browser or use for probes/Workers. | Your Supabase project's API settings |
| `SUPABASE_URL` | app, tests, configuration sample | app: required | Supabase project API URL for the app; localhost with port is allowed for a local instance. | Your Supabase project's API settings |
| `SystemRoot` | CLI | Optional / tool-managed | Windows runtime directory inherited by CLI child-process tests. | Operating system |
| `TELEGRAM_BOT_TOKEN` | app, sender Worker, watchdog Worker, configuration sample | app: optional / defaulted; sender Worker: required; watchdog Worker: required | Bot credential shared by app, sender and watchdog; the sender requires it. | Your Telegram bot setup |
| `TELEGRAM_WEBHOOK_SECRET` | app, sender Worker, configuration sample | app: optional / defaulted; sender Worker: required | 32 random base64url bytes; sender webhook validation secret, also supplied to Telegram setWebhook. | Your secret generator |
| `TEST_ADMIN_EMAIL` | tests, configuration sample | Optional / tool-managed | Disposable Clerk development address using the test subaddress; the harness derives other accounts. | Your isolated Clerk development instance |
| `TEST_VERIFICATION_CODE` | tests, configuration sample | Optional / tool-managed | Fixed verification code accepted only with Clerk development Test mode enabled. | Your Clerk testing configuration |
| `UV_THREADPOOL_SIZE` | probe | Optional / tool-managed | Node thread pool capacity; probes default to 64. | Probe runtime or your service configuration |
| `WATCHDOG` | watchdog Worker | Required Durable Object binding | Durable Object namespace binding for serialized checks and durable receipts. | Your Worker configuration, Watchdog class |
| `WATCHDOG_PROBES` | watchdog Worker, configuration sample | watchdog Worker: required | Comma-separated expected probe ids; nonempty and unique. | Your fleet configuration |
| `WATCHDOG_TELEGRAM_CHAT_ID` | watchdog Worker, configuration sample | watchdog Worker: required | Operator chat or group id for independent fleet-health alerts. | Your Telegram operator chat |

The test harness may create disposable Clerk users, organizations and database rows. Use isolated development resources only. Set the public test helpers' development-project guard to your own disposable project before running integration or browser tests. Never point them at production.
