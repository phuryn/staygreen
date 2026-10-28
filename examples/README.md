# Sample deployment files

The files Staygreen's own provisioning writes for the probes, the status edge, the alert sender and the watchdog, with placeholders where the hosted service has its own names, addresses and secrets. Replace every `<…>` and every `example.com` name. [Deploying](../docs/deploying.md) gives the order; [the environment reference](../docs/environment.md) describes every variable. Box commands run as root on Ubuntu 24.04, from the folder you copied the files to.

## Probe boxes

**`probe/setup.sh`** prepares a fresh box: Node 22, ufw, unattended security upgrades, the `staygreen` system user, `/opt/staygreen-probe`, and a firewall that admits SSH from anywhere and port 7070 only from the fleet. Create the box with IPv6 on: Supabase's direct database host is reached over IPv6. Run it on every probe box with the public IPv4 address of every probe, this box's included, and again on every box when the fleet changes.

```sh
bash setup.sh <probe-ip> <probe-ip>
```

**`probe/probe.env.example`** holds every variable the probe reads, one comment each. Make one copy per box with that box's id, location, address and database login, and install it root-only.

```sh
install -m 600 -o root -g root probe.env /etc/staygreen-probe.env
```

**`probe/staygreen-probe.service`** runs `/opt/staygreen-probe/main.js` as `staygreen`, sandboxed, restarting on failure. It needs no edits. Build the bundle at the repository root with `npm run probe:build`, put `sha256sum probe/dist/main.js` in the box's `PROBE_RELEASE`, copy `probe/dist/main.js` and the unit to the box, then:

```sh
install -m 644 -o root -g root main.js /opt/staygreen-probe/main.js
install -m 644 -o root -g root staygreen-probe.service /etc/systemd/system/staygreen-probe.service
systemctl daemon-reload && systemctl enable staygreen-probe && systemctl restart staygreen-probe
curl -s http://127.0.0.1:7070/health
```

Do one box at a time. Move on when `/health` shows the box's `id` and `release`, `"ready": true`, `"unreadable": 0` and a `"healthy"` canary twice in a row. Logs: `journalctl -u staygreen-probe`.

## Status edge

The renderer and Caddy share one of the probe boxes with its probe.

**`edge/setup.sh`** adds the edge to a box `probe/setup.sh` prepared: Caddy from Ubuntu's archive with CPU and memory limits, the `staygreen-edge` system user, `/opt/staygreen-edge`, and ports 80 and 443 open. Run it once on that box: `bash setup.sh`.

**`edge/edge.env.example`** holds the renderer's variables. Fill it in, with `EDGE_RELEASE` computed from the built files as its comment shows, and install it root-only.

```sh
install -m 600 -o root -g root edge.env /etc/staygreen-edge.env
```

**`edge/staygreen-edge.service`** runs the renderer from `/opt/staygreen-edge` as `staygreen-edge`, on 127.0.0.1:7080, within a quarter of a CPU and 192 MB. It needs no edits. Build its five files at the repository root (bash):

```sh
mkdir -p edge/dist
npx esbuild widget/client.ts --bundle --platform=browser --target=es2020 --minify --outfile=edge/dist/w.js
npx esbuild edge/main.ts --bundle --platform=node --target=node22 --external:pg-native --define:process.env.NODE_ENV='"production"' --outfile=edge/dist/main.js
{ cat design/tokens.css; echo; cat design/kit.css; echo; cat src/styles/app.css; echo; cat src/styles/status.css; echo; cat edge/status.css; } > edge/dist/status.css
cp public/icon.svg src/app/fonts/Switzer-Variable.woff2 edge/dist/
```

Copy those five files and the unit to the box, then:

```sh
install -m 644 -o root -g root main.js status.css w.js icon.svg Switzer-Variable.woff2 -t /opt/staygreen-edge
install -m 644 -o root -g root staygreen-edge.service /etc/systemd/system/staygreen-edge.service
systemctl daemon-reload && systemctl enable staygreen-edge && systemctl restart staygreen-edge
curl -s http://127.0.0.1:7080/health
```

`/health` answers `"ready": true` with your `EDGE_RELEASE` once a full read of the published pages has worked and no cache purge is waiting.

**`edge/Caddyfile`** puts Caddy in front of the renderer: your status host with an ordinary certificate, builders' custom domains with on-demand certificates that your app's `/api/edge/ask` approves, strict SNI and Host checks, the original Host passed through, and `/health` closed to the outside. Replace `app.example.com` with your app's origin and `status.example.com` with your status host. In the smallest installation, where the app runs on the same box, uncomment the app's site: without it the app's host falls through to the catch-all. Deploy the app first, so the ask route answers, then:

```sh
install -m 644 -o root -g root Caddyfile /etc/caddy/Caddyfile.next
caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile && mv /etc/caddy/Caddyfile.next /etc/caddy/Caddyfile
systemctl enable caddy && systemctl reload-or-restart caddy
```

On Cloudflare, point the status host at the box as a proxied A record, with the zone's SSL/TLS mode on Full (strict), and `*.<your STATUS_DOMAIN_SUFFIX>` as a DNS-only A record, which builders' CNAMEs reach. `curl -sI https://status.example.com/health` answering 404 is Caddy on the box; a 526 means Caddy has no certificate for the status host yet, so run `systemctl reload caddy` once the record points at the box. Then add two cache rules for the status host, after any others: one that bypasses the cache on `(http.host eq "status.example.com")`, then one that makes it eligible for cache, respecting the origin's edge and browser TTLs, on:

```
(http.host eq "status.example.com" and ssl and http.request.uri.query eq "" and not starts_with(http.request.uri.path, "/page-assets/") and http.request.uri.path ne "/health" and not any(http.request.headers.names[*] in {"origin" "x-forwarded-host" "x-host" "x-forwarded-scheme" "x-original-url" "x-rewrite-url"}))
```

## Workers

Both Workers deploy with the Wrangler that `ingest/` pins: run `npm --prefix ingest ci` once, then use `node ingest/node_modules/wrangler/bin/wrangler.js` from the repository root wherever `wrangler` appears below, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set or after `wrangler login`. Each Worker gets its own database login, made as in `probe.env.example` with its own group role and a hex password (`openssl rand -hex 24`), which needs no escaping in the connection string, and its own Hyperdrive configuration with caching off: a cached answer would skip the database call. Set a Worker's values before its first deploy: Wrangler offers to create the Worker when it doesn't exist yet.

**`sender/wrangler.toml`** configures the alert sender: `sender/worker.ts` on a one-minute cron, with Telegram's webhook at `/api/telegram/webhook` on a custom domain. Copy it to `sender/wrangler.toml`, replace the name, `alerts.example.com` and the Hyperdrive id, and make its login a member of `alert_sender` only. Set the eight required values the file lists, and leave `EMAIL_REDIRECT_TO` unset outside a test deployment, since it sends every alert email to that one address. Deploy, then register the webhook with the same `TELEGRAM_WEBHOOK_SECRET`:

```sh
wrangler hyperdrive create <name>-db --connection-string="postgres://<login>:<password>@db.<project-ref>.supabase.co:5432/postgres" --caching-disabled true
wrangler secret put <NAME> --config sender/wrangler.toml
wrangler deploy --config sender/wrangler.toml
curl -sS "https://api.telegram.org/bot<bot-token>/setWebhook" -H "content-type: application/json" \
  -d '{"url":"https://alerts.example.com/api/telegram/webhook","secret_token":"<webhook-secret>","allowed_updates":["message","my_chat_member"],"drop_pending_updates":false}'
```

`getWebhookInfo` should then show that URL and both update types. `wrangler deploy --dry-run --outdir <folder> --config sender/wrangler.toml` checks the bundle without deploying.

**`watchdog/wrangler.toml`** configures the probe watchdog: `watchdog/worker.ts` on a one-minute cron, with its `WATCHDOG` Durable Object and no public route. Copy it to `watchdog/wrangler.toml`, replace the name and the Hyperdrive id, and make its login a member of `watchdog` only. Set its three values, then deploy:

```sh
wrangler hyperdrive create <name>-db --connection-string="postgres://<login>:<password>@db.<project-ref>.supabase.co:5432/postgres" --caching-disabled true
wrangler secret put <NAME> --config watchdog/wrangler.toml
wrangler deploy --config watchdog/wrangler.toml
```

A new cron can take up to 15 minutes to start running. From then on, a probe that has sent no numbers for ten minutes is named in the operator chat.
