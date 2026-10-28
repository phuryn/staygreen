#!/usr/bin/env bash
# Adds the status edge to a probe box that examples/probe/setup.sh has prepared, as Staygreen's
# own provisioning does. Read it before you run it. Run it as root on the one box that serves
# the status edge:
#
#   sudo bash setup.sh
#
# It installs Caddy from Ubuntu's archive and caps it at a quarter of a CPU and 128 MB, so it
# can't starve the probe; creates the `staygreen-edge` system user and the renderer's
# directory; and opens ports 80 and 443 to everyone. The probe's service is left as it is.
# Safe to run again. The renderer, its env file, its unit and the Caddyfile come next
# (examples/README.md).
set -eu

if [ "$(id -u)" != 0 ]; then
  echo "Run it as root: sudo bash setup.sh" >&2
  exit 1
fi
# The renderer runs on the Node 22 that probe/setup.sh installed.
if ! [ -x /usr/bin/node ]; then
  echo "No /usr/bin/node here: run examples/probe/setup.sh on this box first." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy

# The renderer's account: a system user with no home that can't log in.
id staygreen-edge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin staygreen-edge
# Root owns the renderer's directory, so the service can't replace its own files.
install -d -m 755 -o root -g root /opt/staygreen-edge

# Caddy's limits on this shared box, as a drop-in beside the package's own unit.
install -d -m 755 /etc/systemd/system/caddy.service.d
printf '[Service]\nCPUQuota=25%%\nCPUWeight=20\nMemoryMax=128M\nTasksMax=128\nNice=10\n' > /etc/systemd/system/caddy.service.d/staygreen-limits.conf

# HTTPS for the status host and builders' custom domains; HTTP for certificate challenges and
# Caddy's redirects to HTTPS.
ufw allow 80/tcp
ufw allow 443/tcp
systemctl daemon-reload

echo "Edge host ready. Next: the renderer's files, /etc/staygreen-edge.env, staygreen-edge.service and the Caddyfile (examples/README.md)."
