#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 box to run a Staygreen probe, as Staygreen's own provisioning
# does. Read it before you run it. Run it as root on every probe box, naming the public IPv4
# address of every probe in the fleet, this box's included:
#
#   sudo bash setup.sh <probe-ip> <probe-ip> ...
#
# It installs Node 22, ufw and unattended security upgrades; creates the `staygreen` system
# user and the directories staygreen-probe.service uses; and turns on a firewall that admits
# SSH from anywhere and the probe port, 7070, from the fleet only.
#
# Safe to run again. When the fleet changes, run it again on every box, so each admits the new
# address. It never removes a ufw rule: on a reused box, delete any broader 7070 rule yourself,
# and a retired probe's with `ufw delete allow from <address> to any port 7070 proto tcp`.
# It installs no Staygreen code: the bundle, its env file and the unit come next
# (examples/README.md).
set -eu

if [ "$(id -u)" != 0 ]; then
  echo "Run it as root: sudo bash setup.sh <probe-ip> ..." >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Name the public IPv4 address of every probe in the fleet, this box's included." >&2
  exit 1
fi
# ufw would also accept a network or the word `any`; only single addresses are meant here.
for ip in "$@"; do
  if ! [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Not an IPv4 address: $ip" >&2
    exit 1
  fi
done

export DEBIAN_FRONTEND=noninteractive

# Packages: certificates, curl and gnupg for Node's repository, the firewall, and automatic
# security updates.
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades

# Node 22 from NodeSource, unless Node 22 is already here. The unit runs /usr/bin/node.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]; then
  setup_file=$(mktemp /tmp/staygreen-node.XXXXXX)
  trap 'rm -f "$setup_file"' EXIT
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$setup_file"
  bash "$setup_file"
  apt-get install -y -qq nodejs
  rm -f "$setup_file"
fi

# The service account: a system user that can't log in. Its home is the probe's state directory.
id staygreen >/dev/null 2>&1 || useradd --system --home-dir /var/lib/staygreen-probe --shell /usr/sbin/nologin staygreen
# Root owns the bundle's directory, so the service can't replace its own code.
install -d -m 755 -o root -g root /opt/staygreen-probe
install -d -m 700 -o staygreen -g staygreen /var/lib/staygreen-probe

# Refresh package lists and apply security upgrades daily.
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

# Firewall: SSH from anywhere, the probe port from the fleet's addresses, nothing else in.
# If SSH listens on another port, change 22 before you run this.
ufw allow 22/tcp
for ip in "$@"; do
  ufw allow from "$ip" to any port 7070 proto tcp
done
ufw default deny incoming
ufw default allow outgoing
ufw --force enable

echo "Box ready. Next: the bundle, /etc/staygreen-probe.env and staygreen-probe.service (examples/README.md)."
