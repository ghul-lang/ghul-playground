# The snapshotter: sqlite3 and a shell, and nothing else.
#
# Not the goatcounter image, which carries the server but no sqlite3 binary -
# it links the library rather than shipping the tool. Not a general-purpose
# image either: this reads the one file on the host that cannot be rebuilt, so
# the less in here the better.

FROM alpine:3.24

RUN apk add --no-cache sqlite

# The same user the goatcounter image runs as, because that is who owns the
# database and its write-ahead log. Reading a WAL database means opening its
# -shm file, which is a write, so a different user fails outright - loudly,
# which is what we want if the other image's user ever changes.
RUN adduser -D -u 1000 snapshot

# The directory the snapshot volume is mounted over has to exist here, owned by
# the user that will run. Docker seeds a *new* named volume from whatever is at
# the mount point in the image, ownership included; with nothing there it
# creates the mount point itself as root, the container drops to an
# unprivileged user, and every copy fails with
#
#   unable to open database "/snapshot/analytics.sqlite3.new"
#
# in a loop, while the container itself stays up and healthy-looking. The
# goatcounter image carries the same line for the same reason.
RUN install -d -o snapshot -g snapshot /snapshot

# Copied in rather than mounted over. A bind mount of a single *file* pins the
# inode it was started with, and git does not edit a file in place - it writes a
# new one and renames - so a container started before a change goes on running
# the version it started with, however many times the repository changes. It
# cost us a fix that deployed and did nothing. Carried in the image, a change
# changes the image, and compose replaces the container.
COPY snapshot.sh /snapshot.sh

USER snapshot

# A copy that is not being written is the failure this service can have, and it
# is invisible without this: the loop goes on running, the container stays up,
# and the insights pages quietly read a snapshot that is hours old or absent. Unhealthy
# after two missed intervals says it in the one place anybody looks.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3   CMD [ -f "${SNAPSHOT_TARGET:-/snapshot/analytics.sqlite3}" ]    && [ -z "$(find "${SNAPSHOT_TARGET:-/snapshot/analytics.sqlite3}"         -mmin +$(( (${SNAPSHOT_INTERVAL:-300} * 2) / 60 + 1 )))" ] || exit 1

ENTRYPOINT ["/bin/sh", "/snapshot.sh"]
