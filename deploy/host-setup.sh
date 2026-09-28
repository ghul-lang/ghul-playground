#!/usr/bin/env bash
#
# Everything the playground host needs that is not the application itself.
#
# Idempotent: run it on a fresh Ubuntu box to provision one, or on the running
# host to put a piece back after it has drifted. It changes only what it is
# named for and leaves the rest alone.
#
# It deliberately does NOT do these things, each because they cannot be done
# safely from a script that might be re-run:
#
#   - issue the certificate. Let's Encrypt rate-limits issuance, so a script
#     that re-issues on every run will eventually lock the host out of renewal.
#     See "certificates" in deploy/README.md for the one-time command.
#   - write .env. It holds the origin list and, if the access gate is ever
#     re-enabled, the tokens; it lives only on the host, at mode 600.
#   - set the netcup firewall, which is provider-side. deploy/README.md lists
#     the rules, and the trap in configuring it through the API.
#   - install the deploy user's SSH key. It is created per deployment and held
#     as a CI secret, so it is copied into /home/deploy/.ssh/authorized_keys
#     once by hand; see "deploying" in deploy/README.md.
#
# Usage:  sudo ./deploy/host-setup.sh [--user NAME] [--domain NAME]
#                                    [--docs-domain NAME]

set -euo pipefail

USER_NAME="degory"
DOMAIN="playground.ghul.dev"
DOCS_DOMAIN="ghul.dev"

# The docker network the services share. Pinned in compose.yaml, and repeated
# here because the firewall rules below match on it: if the two ever disagree,
# the containers silently regain the egress these rules exist to remove.
SUBNET="172.31.240.0/24"

while [ $# -gt 0 ]; do
    case "$1" in
        --user) USER_NAME="$2"; shift 2 ;;
        --domain) DOMAIN="$2"; shift 2 ;;
        --docs-domain) DOCS_DOMAIN="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" != 0 ]; then
    echo "run this with sudo" >&2
    exit 2
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

say() { printf '\n== %s\n' "$1"; }

say "packages"

# All from Ubuntu's own archive - there are no third-party apt sources on this
# host, and adding one would be a new thing to trust.
apt-get update -qq
# rsync is here because the deploy copies the published front end with it. It is
# in some Ubuntu images and not others, so a host that happens to have it makes
# the dependency invisible until a host that does not fails the deploy on
# "rsync: command not found".
#
# libnginx-mod-http-brotli-static supplies the brotli_static directive the site
# files use. Without it nginx rejects the configuration as having an unknown
# directive and will not start, so it is not optional on a host built from here.
apt-get install -y -qq --no-install-recommends \
    nginx libnginx-mod-http-brotli-static certbot python3-certbot-nginx \
    docker.io docker-compose-v2 \
    iptables-persistent netfilter-persistent \
    chrony unattended-upgrades rsync

say "ssh"

# A drop-in rather than an edit to sshd_config, so an Ubuntu upgrade replacing
# that file cannot silently undo this. Check that the main config actually
# includes the directory first: without the Include line a drop-in is read by
# nobody and the host looks hardened while accepting passwords.
if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
    echo "sshd_config has no Include for sshd_config.d - refusing to write a drop-in nothing reads" >&2
    exit 1
fi

cat > "$tmpdir/10-hardening.conf" <<'CONF'
# Key-based authentication only, and no direct root login.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
CONF
install -m 644 "$tmpdir/10-hardening.conf" /etc/ssh/sshd_config.d/10-hardening.conf

sshd -t
systemctl reload ssh

say "sudo"

# Written through a temporary file and validated before it is put in place: a
# malformed sudoers file locks every user out of sudo, including the one that
# would fix it.
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "$tmpdir/sudoers"
visudo -cqf "$tmpdir/sudoers"
install -m 440 "$tmpdir/sudoers" "/etc/sudoers.d/90-${USER_NAME}-nopasswd"

say "web root and the acme challenge directory"

# Only the challenge directory here. The web root is created further down,
# alongside the account that owns it - see "deploy user".
install -d -o www-data -g www-data /var/www/certbot

say "nginx"

# The analytics exclusion list, which playground-limits.conf includes by a
# literal path - geo's include does not glob, so there is no "optional file"
# form and a missing one stops nginx from starting at all. Seeded from the
# example, which is entirely comments and so excludes nobody. Never overwritten:
# on a host that has a real list, this is a no-op.
if [ ! -f /etc/nginx/analytics-exclude.conf ]; then
    install -m 644 "$here/nginx/analytics-exclude.conf.example" /etc/nginx/analytics-exclude.conf
fi

# nginx-files.sh lists these same files for check-nginx.sh, which every deploy
# runs, and apply-nginx.sh, which applies a change; a file added here belongs
# there too.
# The long-kept access logs, with addresses cut to their network, and the rule
# that keeps them. Before the nginx config that writes them is installed, so a
# reload never finds their directory missing.
install -d -o root -g adm -m 755 /var/log/nginx/kept
install -m 644 "$here/logrotate/ghul-playground-kept" /etc/logrotate.d/ghul-playground-kept

install -m 644 "$here/nginx/playground-limits.conf" /etc/nginx/conf.d/playground-limits.conf
install -m 644 "$here/nginx/reject-unknown-hosts.conf" /etc/nginx/conf.d/reject-unknown-hosts.conf
install -m 644 "$here/nginx/$DOMAIN.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"

# The documentation site, served from this host as well. It is here because the
# embedded playground needs the page framing it to be cross-origin isolated, and
# only a host we control can send the headers that grant that.
#
# Enabled only once its certificate exists. The server block names the
# certificate, and nginx refuses to load a configuration naming one that is not
# there - so enabling it first would leave a running host whose config is valid
# in memory and broken on disk. Nothing would look wrong until the next reboot
# or the next reload certbot's renewal timer does, at which point nginx fails to
# start and takes the playground down with it. The first run of this script
# therefore installs the file and leaves it disabled; issue the certificate, run
# the script again, and it is picked up.
install -m 644 "$here/nginx/$DOCS_DOMAIN.conf" "/etc/nginx/sites-available/$DOCS_DOMAIN"

if [ -f "/etc/letsencrypt/live/$DOCS_DOMAIN/fullchain.pem" ]; then
    ln -sfn "/etc/nginx/sites-available/$DOCS_DOMAIN" "/etc/nginx/sites-enabled/$DOCS_DOMAIN"
else
    rm -f "/etc/nginx/sites-enabled/$DOCS_DOMAIN"
    echo "no certificate for $DOCS_DOMAIN yet; installed but not enabled"
fi

rm -f /etc/nginx/sites-enabled/default

# Only reload once the certificate exists: the server block references it, and
# nginx will not start without it. On a fresh host this is expected to be the
# state until the issuance step in deploy/README.md has been run.
#
# Only the playground's is checked here. The documentation site is enabled
# above only when its own certificate exists, so a missing one leaves a
# configuration that still loads rather than one that has to be reloaded around.
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    nginx -t
    systemctl reload nginx
else
    echo "no certificate for $DOMAIN yet; skipping the nginx reload"
    echo "see 'certificates' in deploy/README.md"
fi

say "deploy user"

# The account CI deploys as. It is kept separate from the interactive login so
# the deployment path and its key can be revoked without touching either, and
# so the two leave separate audit trails.
#
# It gets exactly what a deploy needs and nothing more: ownership of the two
# directories it writes, and docker access to rebuild the services. The clone
# is an anonymous HTTPS checkout of a public repository, so it needs no GitHub
# credential. No sudo is involved in the deploy at all.
if ! id deploy >/dev/null 2>&1; then
    useradd --create-home --shell /usr/bin/bash deploy
fi
usermod -aG docker deploy
# The interactive user stays able to log in and, in an emergency, to sudo, but
# is not one of the accounts that touches docker day to day.
gpasswd -d "$USER_NAME" docker >/dev/null 2>&1 || true

install -d -o deploy -g deploy -m 700 /home/deploy/.ssh

# The web root, created here rather than with the other directories above so
# that it is never owned by anyone but the account that writes it. nginx only
# reads it, as www-data, through directory permissions.
#
# It used to be created as www-data earlier and handed over here, which made the
# script safe to re-run but not safe to re-run and *fail*: an abort in between -
# a bad nginx config, say - left the web root owned by www-data, and the next
# deploy died on "mkstemp ... Permission denied" with nothing pointing back to
# this script as the cause.
install -d -o deploy -g deploy /var/www/playground
chown -R deploy:deploy /var/www/playground

# The documentation site's root, on the same terms. It is written by the same
# deploy account, from the ghul-dev repository's own workflow.
install -d -o deploy -g deploy /var/www/ghul-dev
chown -R deploy:deploy /var/www/ghul-dev
# Present only once the application has been cloned; a fresh host gets it
# after this script, so do not fail when it is not there yet.
if [ -d /opt/ghul-playground ]; then
    chown -R deploy:deploy /opt/ghul-playground
fi

say "firewall"

# Two separate jobs, and the second is easy to believe the first has covered.
#
# DOCKER-USER is consulted for FORWARDed traffic, which is how a container
# reaches the internet - so it denies that. It is NOT consulted for traffic to
# the host itself, which arrives on INPUT, so on its own it leaves the
# containers able to reach the host's own sshd and nginx. Both rules are needed;
# neither is visible from the other.

# Removed and re-added rather than checked, because order is load-bearing here:
# the ESTABLISHED rule has to precede the DROP, or replies travelling back to
# nginx match the DROP and the site goes down.
while iptables -D DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN 2>/dev/null; do :; done
while iptables -D DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j RETURN 2>/dev/null; do :; done
while iptables -D DOCKER-USER -s "$SUBNET" -j DROP 2>/dev/null; do :; done

# Inserted at the head in reverse, so they end up in the order written here.
iptables -I DOCKER-USER 1 -s "$SUBNET" -j DROP
iptables -I DOCKER-USER 1 -s "$SUBNET" -d "$SUBNET" -j RETURN
iptables -I DOCKER-USER 1 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# New connections only, so replies from the containers to nginx are unaffected.
if ! iptables -C INPUT -s "$SUBNET" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
    iptables -I INPUT 1 -s "$SUBNET" -m conntrack --ctstate NEW -j DROP
fi

netfilter-persistent save

say "locale and timezone"

# Sorting and number formatting should not depend on where the machine happens
# to be, and everything a log here is read against - GitHub Actions, the wiki,
# certbot - is UTC. C.UTF-8 rather than plain C: the latter is ASCII-only, and
# there is non-ASCII in the content this host serves.
localectl set-locale LANG=C.UTF-8
timedatectl set-timezone UTC

say "snaps"

# Nothing here uses snapd, and a second package manager on a host whose whole
# appeal is being reproducible from this script is a second thing to keep
# current. Held so an apt upgrade cannot quietly bring it back.
if command -v snap >/dev/null 2>&1; then
    for s in $(snap list 2>/dev/null | awk 'NR>1 {print $1}' | grep -v '^snapd$'); do
        snap remove --purge "$s" || true
    done
    snap remove --purge snapd 2>/dev/null || true
    systemctl disable --now snapd.service snapd.socket snapd.seeded.service 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq snapd || true
    rm -rf /var/cache/snapd /var/lib/snapd /snap /root/snap
fi
apt-mark hold snapd >/dev/null

say "unattended upgrades"

cat > "$tmpdir/20auto-upgrades" <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
install -m 644 "$tmpdir/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades

say "root password"

# The console is the only place a password could still be used - ssh is
# key-only above. Locking it costs nothing and closes the last use of a
# credential that has been shared in plain text.
passwd -l root > /dev/null

say "done"

echo "still to do by hand, if this is a fresh host:"
echo "  - issue both certificates          (see deploy/README.md)"
echo "  - write /opt/ghul-playground/.env  (origins; tokens optional, mode 600)"
echo "  - set the netcup firewall policy   (see deploy/README.md)"
echo "  - install the deploy SSH key       (see deploy/README.md)"
echo "  - write /etc/nginx/analytics-exclude.conf (optional), from the"
echo "    .example in deploy/nginx/ - wanted BEFORE any site points at the"
echo "    analytics: a visitor cannot be removed from it afterwards"
echo "  - create the GoatCounter site      (see 'analytics' in deploy/README.md)"
