# the host

What a playground host is, beyond the application itself. `host-setup.sh` puts
all of it in place and is safe to re-run; this file is the part a script cannot
carry, which is the reasoning and the three things it deliberately leaves alone.

The box is a netcup VPS, 8 vCPU / 16 GB, Ubuntu. Everything installed *by apt*
comes from Ubuntu's own archive: nginx, certbot, docker.io, docker-compose-v2,
iptables-persistent, chrony, unattended-upgrades. There are no third-party apt
sources, and adding one would be a new thing to trust.

netcup's Ubuntu image arrives with snapd and a couple of snaps, none of which
anything here uses; they are purged and held, so the only package manager on the
host is apt. It also arrives set to `en_US.UTF-8` and the timezone of wherever
the machine is. Both are changed: `C.UTF-8`, because sorting and number
formatting should not depend on a locale, and UTC, because everything a log is
read against - GitHub Actions, the wiki, certbot - is already UTC, and because
a zone that observes DST gives you one repeated hour and one missing hour a year.

There is one piece of software on this host that Ubuntu does not package, and
pretending otherwise would be worse than saying so: **GoatCounter**, the
analytics. It is not apt-installed - it is built from source at a pinned tag by
`goatcounter/Dockerfile` and runs in a container like the other two services. So
the rule above is intact as a statement about apt, and the honest version of the
broader claim is: one upstream Go program, built here from a revision we name,
rather than a binary or an image someone else assembled. See "analytics" below.

Treat the host as disposable **with one exception**. It holds no credentials
beyond its own certificate - the services run open by default and carry no
access tokens - and rebuilding it is `host-setup.sh` plus the steps below. The
exception is the analytics volume, which is the only state here that is not
reproducible from this repository: rebuild the box without copying it and the
history is gone for good. Everything else can be thrown away freely.

## what runs where

nginx terminates TLS. The playground is served by the ghul.dev site, at
`/playground/` from `/var/www/playground`, with the REPL at `/repl/`; it proxies
the compile and analyse containers under `/playground/`, and `/stats/` to the
GoatCounter container. All three are bound to loopback and never face the
internet themselves. The containers come from `compose.yaml` in the repository
root.

`playground.ghul.dev`, where the playground used to be, redirects its pages
(`/`, `/index.html`, `/embed.html`, `/rosetta-code/...`) permanently to the same
path under `https://ghul.dev/playground`, and `/repl.html` to `/repl/`. It still
proxies `/compile`, `/compile/cell`, `/analyse`, `/health` and `/stats/`, and still
serves the playground's other files from `/var/www/playground`: a page open from
before the move posts to the services, opens WebSockets to them and loads files
later (the .NET runtime on its first run), and none of that follows a redirect
to another origin. Its
certificate and name are kept.

The nginx files in `nginx/` are installed by hand, not by the deploy, which
has no root. The deploy does check them: its last step runs `check-nginx.sh`
on the host, which fails the run while the live files differ from the
repository's. To apply them, once the deploy has pulled the change:

```sh
sudo /opt/ghul-playground/deploy/apply-nginx.sh
```

It installs only the files that differ, backs up the live ones to
`/var/backups/ghul-playground-nginx/<timestamp>/`, and reloads nginx only if
`nginx -t` passes; if it fails, the previous files are put back and nginx keeps
running what it had. With nothing to change it does nothing. The files it
covers are listed in `nginx-files.sh`. `host-setup.sh` installs them too, but
it also does first-time setup, so it is not the thing to run for an nginx
change.

Both site files use `brotli_static`, which comes from a module package that
Ubuntu's `nginx` does not pull in. A host built by `host-setup.sh` now gets it,
but one built before that does not, and nginx rejects an unknown directive
rather than ignoring it - so install the package **before** applying the files:

```sh
sudo apt-get install -y libnginx-mod-http-brotli-static
sudo /opt/ghul-playground/deploy/apply-nginx.sh
```

Applying first is safe rather than harmful: `nginx -t` fails, `apply-nginx.sh`
puts the previous files back, and nginx carries on serving what it had. What it
leaves behind is a `check-nginx.sh` failure on every deploy until the package is
in and the files are applied, which reads as an unrelated deploy failure.

The point of it is that the publish already writes a `.br` beside every `.gz`
and nothing was serving them: brotli is about a quarter smaller than gzip across
the runtime's assemblies, and a client that offers brotli and not gzip was being
served no compression at all. Confirm it took with

```sh
curl -sI -H 'Accept-Encoding: br' https://ghul.dev/playground/main.js | grep -i content-encoding
```

It also serves the documentation site, `ghul.dev` and `www.ghul.dev`, from
`/var/www/ghul-dev`. Under that site the playground is also served at `/playground/`, from
its own directory with its services beside it under the same limit zones, and
the REPL at `/repl/`, whose entry page (`repl-entry.html`, written at publish
from `repl.html`) takes everything else from `../playground/`. `/stats/` is
proxied there too, under the playground host's name so counts land in the same
history. That site used to be on GitHub Pages, and it is here for
one reason: the playground runs the .NET runtime on a worker thread so that a
program can block reading a line of input, which needs a `SharedArrayBuffer`,
which needs the page to be cross-origin isolated. Isolation is granted by two
response headers, Pages sends no custom headers at all, and a cross-origin frame
is isolated only when the document framing it already is - so an embedded
playground on Pages could never be isolated, whatever this host sent.

The two sites share nothing but the host: separate roots, separate server
blocks, separate certificates, and the documentation site is deployed by the
`ghul-dev` repository's own workflow rather than by this one. What they do share
is a failure: an outage now takes out both, where before it left the
documentation up. That is less of a change than it sounds, since the site
already depends on this host for the embedded playground and for the analytics,
but it is worth knowing before an outage rather than during one. There is no
standby copy: the site builds with its links rooted at `/`, so a copy served
from a project URL would 404 on every asset it loads, and a broken standby is
worse than none. What the documentation site's workflow keeps instead is the
built site as a run artifact, which can be served from anywhere.

## the things host-setup.sh does not do

**Certificates.** Let's Encrypt rate-limits issuance, so a provisioning script
that re-issues every time it runs will eventually lock the host out of renewal.
Issue once, by hand, after DNS points at the host.

There are two, one per site, and the documentation site's covers both of its
names. Adding the second one to a host that is already serving the playground
goes in this order, and the order is what keeps the playground up:

1. `sudo ./deploy/host-setup.sh`. It installs the documentation site's server
   block but leaves it disabled, because the block names a certificate that
   does not exist yet.
2. Move the `A` and `AAAA` records for `ghul.dev` and `www.ghul.dev` off the
   GitHub Pages addresses and on to this host. Validation is against whatever
   the name resolves to, so this cannot wait until after the next step.
3. Issue the certificate, below.
4. `sudo ./deploy/host-setup.sh` again. The certificate now exists, so the site
   is enabled and nginx reloads.

**On a host that has never had a certificate, `--webroot` cannot work**, and the
reason is circular: the port 80 server block that serves
`/.well-known/acme-challenge/` lives in the site config, and nginx refuses to
load that config at all while the certificate the HTTPS block references is
missing. So nginx is running, port 80 answers, and the challenge path 404s. Use
`--standalone`, which binds port 80 itself:

```sh
sudo systemctl stop nginx
sudo certbot certonly --standalone -d playground.ghul.dev
sudo certbot certonly --standalone -d ghul.dev -d www.ghul.dev
```

The second is named `ghul.dev`, after its first name, which is the path
`nginx/ghul.dev.conf` expects under `/etc/letsencrypt/live/`. Adding a name to
an existing certificate later changes nothing about that path, so the config
does not have to follow.

`--standalone` then leaves two files uncreated that `--nginx` would have written
and that the site config includes, so nginx fails to start afterwards on a
missing-file error that reads as unrelated. Both ship inside the already
installed `python3-certbot-nginx`:

```sh
sudo install -m 644 /usr/lib/python3/dist-packages/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
    /etc/letsencrypt/options-ssl-nginx.conf
sudo install -m 644 /usr/lib/python3/dist-packages/certbot/ssl-dhparams.pem \
    /etc/letsencrypt/ssl-dhparams.pem
sudo nginx -t && sudo systemctl start nginx
```

**Renewal is a different case and does use webroot**, which is why the challenge
path is served directly from the port 80 block rather than redirected: once a
certificate exists the site config loads, so renewal does not depend on anything
in the HTTPS block and does not need nginx stopped. Renewal is certbot's own
systemd timer and needs no cron entry.

**The analytics exclusion list and the GoatCounter site.**
`/etc/nginx/analytics-exclude.conf` is an optional list of networks whose visits
are not recorded; it is not in the repository, and
`nginx/analytics-exclude.conf.example` documents the format. The site inside
GoatCounter is created once, by hand, for the same reason the certificate is: it
takes a password, which is the dashboard login. Note that a visitor's data
cannot be removed once recorded, so an exclusion list is worth having in place
before the numbers are worth keeping.

**The `.env` file.** `/opt/ghul-playground/.env`, mode 600, never in the
repository. It holds two settings, read by `compose.yaml`:

```
PLAYGROUND_TOKENS=
ALLOWED_ORIGINS=https://ghul.dev,https://www.ghul.dev,https://playground.ghul.dev
```

`https://playground.ghul.dev` stays in the list for as long as that host proxies
the services, since a page opened there before the move still calls them from
that origin. It goes when those proxies do.

The playground runs open: `PLAYGROUND_TOKENS` is empty, so anyone may compile
and run. That is deliberate - what bounds the load is the concurrency caps and
the per-address limits in nginx, not authentication - and the services note at
startup that no tokens are configured. Setting `PLAYGROUND_TOKENS` to a
comma-separated list re-enables the gate, and both services then require one.

`ALLOWED_ORIGINS` is a separate axis and is not access control: a request with
no browser `Origin`, such as a `curl`, is still accepted. It stops a
third-party page from driving the service through its own visitors' browsers,
and it has to include the playground's own origin because a POST carries
`Origin` even same-origin.

**The netcup firewall**, which is provider-side, configured through the Server
Control Panel or its REST API. Both implicit rules are `DROP_ALL`, so everything
the host needs is named in one policy, `playground-egress`:

| Direction | Protocol | Port | For |
| --- | --- | --- | --- |
| INGRESS | TCP | 22 | ssh |
| INGRESS | TCP | 443, 80 | the site, and the ACME challenge |
| INGRESS | UDP | *source* 53, 123 | replies to our own DNS and NTP queries |
| EGRESS | TCP | 443 | image pulls, NuGet, GitHub, ACME |
| EGRESS | TCP | 80 | apt, which is configured over plain http here |
| EGRESS | TCP | 4460 | the NTS key exchange chrony does before NTP |
| EGRESS | UDP | 53, 123 | DNS, NTP |
| EGRESS | TCP | *source* 22, 443, 80 | replies to inbound connections |

netcup also attaches two policies of its own: a mail block, which drops outbound
SMTP and which we want, and a ping allow.

Several of these are easy to miss, and each fails in a way that looks nothing
like a firewall rule.

- apt on this host really is plain http, so port 80 is a dependency rather than
  a courtesy.
- chrony syncs over NTS, whose key exchange runs on TCP 4460 before NTP speaks
  UDP 123 at all: allow 123 alone and time sync silently never happens.
- **The firewall is stateful for TCP but not for UDP.** Return traffic for a
  connection the host started is accepted automatically - but only for TCP, so
  DNS and NTP replies need the two *source*-port ingress rules above, or there is
  no name resolution and no clock.
- The egress *source*-port rules are belt and braces. netcup documents the
  connection tracking as covering connections originating from the server, which
  leaves replies to inbound connections unstated; naming them costs nothing and
  removes the question.

**The trap, if you configure this through the API.** The write side of
`/servers/{id}/interfaces/{mac}/firewall` takes only `copiedPolicies`,
`userPolicies` and `active`. It has no field for either implicit rule, and it
does not preserve them: every PUT resets both to `DROP_ALL`, and an
`ingressImplicitRule` sent in the body is accepted and ignored. Attaching a
policy that does not itself allow ssh will therefore lock you out the moment it
applies. This is recoverable only because the API does not depend on ssh - which
is the reason to keep the ingress rules in the policy rather than leaning on an
implicit `ACCEPT_ALL` that any later PUT would silently remove.

**The deploy key.** `host-setup.sh` creates the `deploy` account and its
`~/.ssh` directory, but not the key that goes in `authorized_keys`: it is
created per deployment and held as a CI secret. See "deploy key" under
deploying.

## the firewall rules on the host, and why there are two

Egress from the containers is denied on the host rather than at the provider's
edge, because container traffic is SNATed to the host address and the two are
indistinguishable from outside.

It takes two rules that look like one, and the second is easy to believe the
first has covered:

- `DOCKER-USER` is consulted for **forwarded** traffic, which is how a container
  reaches the internet. This is the rule everyone writes.
- It is **not** consulted for traffic addressed to the host itself, which
  arrives on `INPUT`. Without a matching rule there, the containers still reach
  the host's own sshd and nginx, and nothing in the `DOCKER-USER` rules hints at
  it. Confirmed by connecting from inside a container before the rule existed.

Order matters in the first set: the ESTABLISHED rule has to precede the DROP, or
replies travelling back to nginx match the DROP and the site goes down. That is
why `host-setup.sh` removes and re-adds those three rather than checking whether
each is present.

**These rules are IPv4 only, and that is currently correct rather than an
oversight.** They are `iptables` rules matching an IPv4 subnet, with nothing
equivalent in `ip6tables` - which is sound only because docker's IPv6 is off, so
the containers have no IPv6 address to reach anything from. The host itself does
have working IPv6, and the provider firewall covers both families, so this is the
one layer that does not. Enabling docker IPv6 would silently hand the containers
the egress these rules exist to remove; if that ever happens, the `DOCKER-USER`
and `INPUT` rules need `ip6tables` counterparts in the same change.

**Re-run `host-setup.sh` after recreating the docker network.** The subnet is
pinned in `compose.yaml` precisely so these rules keep matching, but a rule that
has been flushed is invisible: everything works, and the containers quietly have
the internet back. Checking is
`sudo iptables -S DOCKER-USER` and `sudo iptables -S INPUT`.

One trap in how they persist: `netfilter-persistent save` writes out the whole
table, which includes docker's own generated rules and the bridge interface
names current at that moment. Those names change when the network is recreated,
so the saved file ages. It restores harmlessly, because docker rebuilds its own
chains at start, but do not read `/etc/iptables/rules.v4` as the statement of
what we intended. `host-setup.sh` is that statement.

## analytics

GoatCounter, self-hosted, serving `ghul.dev/stats`; ghul.dev and this playground
report to it as one site, whose vhost is `ghul.dev`. `playground.ghul.dev` still
proxies `/stats/count` and `/stats/count.js` with that `Host`, for pages opened
there before the move, and redirects the dashboard. It runs under a path rather than a subdomain of
its own, which upstream supports through `-base-path`. The flag in
`goatcounter/Dockerfile` and the `location` prefix in
`nginx/ghul.dev.conf` have to agree; neither works alone.

Two things about it are worth knowing before touching the host.

**Its volume is the exception to everything else here being disposable.**
`goatcounter-data` holds the entire history, nothing else on the box is
stateful, and nothing backs it up automatically. Rebuild the host without
copying it and the history is gone. Take a copy before any upgrade that migrates
the schema - `-automigrate` runs pending migrations on first start, which is the
point the old database stops being readable by the old binary.
`GOATCOUNTER_VERSION` in `goatcounter/Dockerfile` is the pin, and moving it is
the whole upgrade.

Moving it to another host, which is also how to take that copy. **Stop the
container first**: the database is SQLite in WAL mode, so a running instance has
its recent writes in a `-wal` file beside the database rather than in it, and
copying the three files live is copying a torn database. A clean stop
checkpoints the lot into one file.

```sh
# on the old host
sudo docker compose stop goatcounter
sudo docker run --rm -v ghul-playground_goatcounter-data:/data -v /tmp:/out \
    alpine tar -C /data -czf /out/gc.tgz .

# on the new one, whose volume the first deploy will have created empty
sudo docker compose stop goatcounter
sudo docker run --rm -v ghul-playground_goatcounter-data:/data alpine sh -c "rm -rf /data/*"
sudo docker run --rm -v ghul-playground_goatcounter-data:/data -v /tmp:/in \
    alpine tar -C /data -xzf /in/gc.tgz
sudo docker run --rm -v ghul-playground_goatcounter-data:/data alpine chown -R 1000:1000 /data
sudo docker compose start goatcounter
```

Going through a container rather than `/var/lib/docker/volumes/...` keeps this
independent of where docker stores volumes, and needs no root beyond docker
itself. The site row travels with the database, so a host that receives one does
**not** then need the site created below - and should not have it, since a second
site with the same `cname` is not what records the hits.

**The database starts empty and holds no site**, so a fresh instance serves
nothing until one is created:

```sh
docker compose exec goatcounter goatcounter db create site \
    -vhost=ghul.dev -user.email=YOU@EXAMPLE.COM
```

`deploy/reset-analytics.sh` wipes the history and starts again from empty. It is
the only complete undo there is: GoatCounter never stores a visitor's IP, and
the session it does store is a random identifier rather than anything derived
from one, so there is no way to remove a single visitor's data afterwards.
Deleting by path, from the dashboard, is the only narrower option.

`nginx/analytics-exclude.conf.example` documents an optional list of networks
whose visits are not recorded. The list itself is written by hand on the host
and is not in this repository.

## insights, and what the host is doing

The pages for reading the numbers: `https://ghul.dev/insights/`, behind a
password. They cover what visitors looked at and for how long (time in sight),
how they moved through the site and where they stopped, the funnels through the
playground, the REPL and the examples in the docs, what went wrong for them,
the recent visits one by one, and what the host and each container were doing.
It is a single column that reads on a phone, with a choice of the last day,
week, month or quarter.

They are the `insights` service in `compose.yaml`: node and a few files in
`insights/`, with nothing installed from npm. They write nothing anywhere.

They replace a Grafana instance that was kept off the internet and reached only
over an ssh tunnel, on the grounds that a published route is a login page in
front of a service that can reconstruct a visitor's session. These pages are a
much smaller thing to put on the internet: one password compared in constant
time, no accounts, no sessions, no plugins and no write path, from a service
that is a few hundred lines of this repository's own code - and a tunnel per
look proved too high a price for numbers that were hard to read once reached.
What protects them:

- `INSIGHTS_PASSWORD`, below, as HTTP basic authentication (any user name).
  With it unset **every request is refused**, so a host that has not been
  given one fails closed rather than publishing the visit log.
- The `insights` limit zone in `nginx/playground-limits.conf`, 30 requests a
  minute per address, which makes guessing a long random password hopeless.
- `noindex`, `no-store` and `no-referrer` on every response, a content security
  policy that allows nothing but inline styles, and no link to the pages from
  anywhere.

An address allow-list was considered and rejected on evidence rather than
taste: the same question came up for the analytics exclusion, and over ninety
days this site's own addresses appeared in three distinct /24s on home fibre and
sixteen addresses on mobile. A list wide enough to work admits every other
subscriber on those carriers' pools; one narrow enough to mean anything locks
the reader out from a phone.

Over a tunnel works too, and needs the password as well:

```sh
ssh -L 5094:127.0.0.1:5094 playground.ghul.dev
```

then <http://localhost:5094/>.

To turn it on:

```sh
# on the host, in /opt/ghul-playground/.env
INSIGHTS_PASSWORD=<the output of: openssl rand -base64 24>

sudo docker compose up -d insights
sudo /opt/ghul-playground/deploy/apply-nginx.sh
```

Until `apply-nginx.sh` has been run, `check-nginx.sh` fails every deploy,
because the live nginx files differ from the repository's.

`test/insights.mjs` checks what the pages count against a snapshot whose
numbers are known, and that the service refuses no password, refuses a wrong
one, and refuses everything when none is set.

Prometheus, node-exporter and cAdvisor answer nobody but the insights service
and each other, and are not published at all.

The pages read two things, and they are separate on purpose.

**What the host is doing** comes from Prometheus, which scrapes the machine
(node-exporter) and the containers (cAdvisor) every thirty seconds and keeps
ninety days. That is what Prometheus is for. It is also why visitor analytics
are *not* in it: it stores series that have already been aggregated, so it can
say how many visits there were at nine o'clock and can never say what one
visitor did next.

**What visitors did** comes from a copy of GoatCounter's database, taken by the
`snapshot` service every five minutes and mounted into the insights service
read-only. The pages cannot reach the live database at all. The copy exists
because the live one is in WAL mode: a reader has to be able to create the
`-shm` file beside it, which a read-only mount refuses, and a read-write mount
would put a second writer on the only irreplaceable thing on this host.

cAdvisor runs **without the Docker socket**. The usual recipe mounts it, which
is root on this machine for anything that gets into that container.

What that would cost is the container's *name*. cAdvisor learns names from
Docker's API, and its Docker factory wants containerd's socket as well, so a
read-only proxy in front of the Docker socket does not buy them either - both
were tried. Reading the cgroups directly gives a series per container keyed by
the cgroup path, and the name is put into that path instead: every service sets
`cgroup_parent` to a slice named after itself, so a container's cgroup is
`/playground-<service>.slice/docker-<id>.scope`, and Prometheus lifts the
service name out of it into the `container` label. The name is stable across
deploys, where the id changes with every one.

`--docker_only` is deliberately **not** set. It reports only containers cAdvisor
identified through Docker, which without those sockets is none: it reported a
single series, the root cgroup, which is the machine rather than a container.
The cgroups that are not containers are dropped at scrape time - there are sixty
of them to every container, the machine's own numbers come from node-exporter,
and they would otherwise be most of what this job stores.

### two settings the host supplies

Both go in `/opt/ghul-playground/.env` beside the tokens, written by hand, and
neither is in this repository.

`INSIGHTS_PASSWORD` is the password for the insights pages, above. Compose
does not require it: a deploy made before it is set still succeeds, and the
service refuses every request until it is. The value is on the host and
nowhere else.

`SNAPSHOT_EXCLUDE` says which recorded visits are the site's own rather than a
visitor's, and is applied to the **copy**: the live database keeps every row it
has ever had, and this must never be the thing that clears it. Doing it here
rather than in the pages means no query has to know, and that what is
excluded - which describes whoever runs the site rather than the service - stays
off a public repository.

One line, rules separated by `;`, each rule's own fields by `|`:

| rule | removes |
| --- | --- |
| `location\|XX` | every visit recorded in that place |
| `location-window\|XX\|<from>\|<to>` | that place, between two timestamps |
| `path\|<pattern>` | paths matching a SQL `LIKE` pattern |

A rule naming nothing removes nothing, and a rule of an unknown kind is
reported and skipped, so a mistake costs a snapshot rather than data. The next
copy is five minutes away regardless, so changing the rules needs no more than
editing `.env` and restarting the one service.

`test/snapshot-rules.sh` checks what each kind of rule removes and that the
source database is untouched; `test/insights.mjs` reads a snapshot built with
GoatCounter's own schema.

The snapshot service reports itself unhealthy when the copy is missing or older
than two intervals, and the deploy asks it and Prometheus what they are actually
running (`check-running-config.sh`). That is worth knowing because the failure it has is quiet:
the loop goes on running and the container stays up, so without the health check
the only sign is a page that is emptier than it should be.

**If the copies fail** with `unable to open database
"/snapshot/analytics.sqlite3.new"`, the volume's mount point is owned by root
rather than by the user the container runs as. Docker seeds a named volume from
the image's mount point - ownership included - whenever the volume is **empty**,
not only when it is newly created, so bringing the service up on an image that
owns that directory is usually enough to fix it by itself.

Where it is not - the volume has a copy in it already, so nothing is re-seeded -
the volume has to go. `docker volume rm` refuses while any container still
references it, and stopping a container does not release it, so the containers
have to be removed rather than stopped:

```sh
cd /opt/ghul-playground
sudo docker compose rm -sf snapshot insights
sudo docker volume rm ghul-playground_goatcounter-snapshot
sudo docker compose up -d snapshot insights
```

Nothing is lost: the volume holds one copy of the analytics database and the
next one is along within five minutes.

### what the pages can show

Only what GoatCounter already stores. It keeps no address under any setting,
and the visit identifier it does keep is random and lives for one visit, so the
visit log shows a sequence of pages within one visit and can never join two.
Nothing is added to the snapshot that GoatCounter does not already hold, and
its `users`, `api_tokens` and `store` tables are dropped from the copy - the
pages have no business holding the counter's own password hash.

## traffic that is not a reader

`reject-unknown-hosts.conf` makes nginx refuse any request whose `Host` is not a
name we serve, which in practice means requests addressed to the bare IP. It
closes the connection with 444, and refuses the TLS handshake outright rather
than presenting a certificate for a name the client did not ask for.

Without it nginx answers on the address as well as the name, and scanners find
it that way. The content is public either way, so this is not concealment: it is
that address-scan traffic is never a reader, and there is no reason to serve it,
log it, or let it spend from the per-address limits real readers share.

Expect a steady background of this regardless: probes for `/.env` and its
variants, `/wp-login.php`, and raw TLS or RDP handshakes sent to port 80. The
`.env` probes are the ones worth understanding rather than dismissing: the file
lives at `/opt/ghul-playground/.env`, outside the web root, so it is not
reachable. Today it holds only the origin list, but it is also where the access
tokens would live if the gate were re-enabled, so keep it there. Worth
re-checking with
`curl -s -o /dev/null -w '%{http_code}' https://ghul.dev/.env` after
any change to the nginx roots.

## logs, and how long they are kept

- **compile and analyse** log to the host journal (the `journald` driver in
  `compose.yaml`), so what they said survives the container recreation every
  deploy does. Read them with
  `journalctl CONTAINER_TAG=ghul-playground-compile` (or `-analyse`), and add
  `--grep '^outcome '` for the one-line-per-request outcome records, which carry
  no source text and no client address. How long they last is the journal's
  own limit, and the journal is one store for the whole host: the two services
  share `SystemMaxUse` in `/etc/systemd/journald.conf` with everything else
  that logs there, and the oldest entries go first when it fills. A burst from
  anything on the host shortens how far back their records reach. To keep them
  longer, raise `SystemMaxUse` (or set `MaxRetentionSec`) and restart
  `systemd-journald`; `journalctl --disk-usage` shows how much it holds.
- **nginx** writes each access log twice: once with whole client addresses,
  kept 14 days by the distribution's logrotate rule, and once under
  `/var/log/nginx/kept/` with the address cut to its network (an IPv4 /24, an
  IPv6 /48), kept 180 days by `deploy/logrotate/ghul-playground-kept`. The
  first is for finding one client; the second is for trends.

On a host set up before the kept logs existed, install their directory and
rotation rule **before** the next `apply-nginx.sh` after this change is
deployed. The configuration it applies writes to the directory, and nginx
refuses to reload when an `access_log` directory is missing, so running it
first fails the reload and leaves the previous configuration in place:

```sh
sudo install -d -o root -g adm -m 755 /var/log/nginx/kept
sudo install -m 644 deploy/logrotate/ghul-playground-kept /etc/logrotate.d/ghul-playground-kept
sudo deploy/apply-nginx.sh
```

## who does the deploying

A dedicated `deploy` account, not the interactive one. The services run in
containers that drop to an unprivileged user, and nginx runs as `www-data`, so
nothing is hosted as `deploy` either - it exists only to deploy. It has exactly
what a deploy needs and no sudo: it owns `/opt/ghul-playground`,
`/var/www/playground` and `/var/www/ghul-dev`, and it is in the `docker` group
so it can rebuild the services. The documentation site's workflow logs in as the
same account with the same key, so adding it needed no new credential on this
host. The clone is an anonymous HTTPS checkout of a public repository, so it
pulls without a GitHub credential. `host-setup.sh` creates the account and the
ownership; CI logs in as it.

The interactive account is kept out of the deployment path on purpose, so its
key and the deploy key can be rotated or revoked independently and the two leave
separate trails.

## deploying

Merging to `main` deploys. The `deploy` workflow publishes the web app, pulls the
new `main` on the box and builds both services (trying a failed build once more
after a minute), swaps them, and only then copies `wwwroot` to
`/var/www/playground`, and finally checks the site answers and that the freshly
built toolchain compiles. A build that fails stops the run with nothing live
changed. It runs as `deploy` over SSH, with no
sudo anywhere. It also has a manual trigger for re-running a deploy without a
new merge.

Because the runtime version lives in both the published front end and the
service images, the two are deployed in the same run; deploying only one is how
the browser ends up loading a runtime the services did not compile against.

Deploying is what puts a merged compiler or runtime update in front of readers.
Until the services are rebuilt they keep running the versions their images were
built with, whatever main says.

**A deploy does not install nginx configuration.** It runs as `deploy`, which
has no sudo by design, so anything under `/etc/nginx` is out of its reach. A
merged change to `nginx/*.conf` therefore has no effect until someone re-runs
`sudo ./deploy/host-setup.sh` on the host, and the symptom in the meantime is a
plain 404 on whatever the new configuration was meant to serve - the site is up,
the container is running, and nothing anywhere reports a problem. Re-running the
script is idempotent and is the intended way to apply such a change.

### deploy key

The workflow authenticates with a dedicated SSH key, held as the
`PLAYGROUND_DEPLOY_KEY` secret, whose public half is the only entry in
`/home/deploy/.ssh/authorized_keys`. Generate one per deployment
(`ssh-keygen -t ed25519`), add the public half to that file, and keep the
private half only in the secret. `host-setup.sh` creates the account and its
`.ssh` directory but not the key, for the same reason it does not write `.env`.

### doing it by hand

If CI is not available, the same steps from a machine holding the deploy key:

```sh
npm install                       # stages monaco, and the publish fails without it
dotnet publish web -c Release -o /tmp/playground-publish
rsync -az --delete -e "ssh -i <deploy-key>" \
    /tmp/playground-publish/wwwroot/ deploy@HOST:/var/www/playground/
ssh -i <deploy-key> deploy@HOST \
    'cd /opt/ghul-playground && git pull --ff-only \
     && docker compose build && docker compose up -d'
```

`/opt/ghul-playground` is a single-branch clone, so a branch other than main
needs naming explicitly: `git fetch origin BRANCH && git checkout FETCH_HEAD`.

## moving to a new compiler or runtime

Renovate proposes these, so the usual answer is to let it. It knows all five
places the versions are written, and CI checks that they agree, that the
examples still compile, and that a program still runs in a browser. A green
pull request is the whole review.

To do it by hand, the five are:

| where | what |
| --- | --- |
| `.config/dotnet-tools.json` | the compiler, for local development |
| `web/web.csproj` | the runtime the browser loads |
| `runner/runner.ghulproj` | the runtime the runner builds against |
| `compile-service/Dockerfile` | both, as build arguments |
| `analyse-service/Dockerfile` | both, and the language server |

They have to move together. `node scripts/check-versions.js` says so if they
have not, which is the same check CI runs.

The runtime is the one to be careful with: the services compile a reader's
program against one runtime and the browser loads another, so a version left
behind in `web/web.csproj` is a program that compiles, downloads, and then
fails to load - with nothing in the compiler output to explain it. Nothing
short of running a program in a browser catches that, which is why CI does.

## getting back in

ssh is key-only and **no account on this host has a password at all** - root,
`degory` and `deploy` are all locked. That is deliberate: access is exactly the
set of keys in `authorized_keys` and nothing else. It also means the SCP console
cannot help, because there is no credential to type into it.

The routes back, in order: another key already in `authorized_keys`; the
firewall API, if what locked you out was the firewall, since it does not depend
on ssh and the policy is what decides whether port 22 is reachable; netcup's
rescue system, which boots a rescue image with the disk mounted, from which the
authorized keys can be edited.

If none of that appeals, the honest answer for a box this disposable is to
rebuild it: `host-setup.sh` plus the steps above.

Putting a password on `degory` would restore the console as a route. It is a
deliberate choice not to: a password that exists is a password that can be
guessed or reused, and the rescue system covers the same ground without one.
