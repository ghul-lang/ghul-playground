#!/usr/bin/env bash
# What the analytics snapshot keeps and what it drops.
#
# The snapshotter runs DELETE against a copy of the site's analytics, so what it
# removes needs to be exactly what the rules name and nothing else. This builds
# a database with a row for each case, runs the real script over it, and checks
# which rows survived.
#
#   test/snapshot-rules.sh
#
# Needs sqlite3; skips rather than fails without one, since it is not part of
# what this repository builds.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)

if ! command -v sqlite3 >/dev/null; then
    echo "ok    (no sqlite3 here; the snapshot rules are unchecked)"
    exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/data" "$work/out"

sqlite3 "$work/data/db.sqlite3" > /dev/null <<'SQL'
pragma journal_mode=wal;
create table paths (path_id integer primary key, path text, event int);
create table hits (hit_id integer primary key, path_id int, location text, created_at text, session text,
                   browser_id int not null default 1, system_id int not null default 1, width smallint);
create table browsers (browser_id integer primary key, name text, version text);
create table systems (system_id integer primary key, name text, version text);
insert into browsers values (1, 'Firefox', '120'), (2, 'Chrome', '150'), (3, 'Chrome', '149');
insert into systems values (1, 'Linux', ''), (2, 'Windows', '11');
create table users (id integer primary key, password blob);
create table api_tokens (id integer primary key, token text);
create table store (key text);
insert into paths values (1, '/', 0), (2, '/deploy-probe', 0), (3, 'playground-run/manual/x', 1);
-- Invented places and dates. Which places and which window the site actually
-- excludes describes whoever runs it rather than the service, and this
-- repository is public - the rules live in the host's environment for that
-- reason, so a fixture that used the real ones here would give away exactly
-- what keeping them out of the dashboards was for.
insert into hits (hit_id, path_id, location, created_at, session) values
 (1, 1, 'XX', '2019-04-01 10:00:00', 'a'),
 (2, 1, 'GB', '2019-04-01 10:00:00', 'b'),
 (3, 2, 'GB', '2019-04-01 10:00:00', 'c'),
 (4, 1, 'YY', '2019-04-02 11:00:00', 'd'),
 (5, 1, 'YY', '2019-04-03 11:00:00', 'e'),
 (6, 3, 'GB', '2019-04-01 10:00:00', 'f');
-- The agent rules: one visit whose landing hit matches and whose event does not
-- on its own, a matching hit with no session, and near misses on width,
-- version and system, then a window that takes one visit and not another.
insert into hits (hit_id, path_id, location, created_at, session, browser_id, system_id, width) values
 (7, 1, 'GB', '2019-04-01 10:00:00', 'g', 2, 1, 1920),
 (8, 3, 'GB', '2019-04-01 10:01:00', 'g', 2, 1, null),
 (9, 1, 'GB', '2019-04-01 10:00:00', 'h', 2, 1, 1280),
 (10, 1, 'GB', '2019-04-01 10:00:00', 'i', 3, 1, 1920),
 (11, 1, 'GB', '2019-04-01 10:00:00', null, 2, 1, 1920),
 (12, 1, 'GB', '2019-04-01 10:00:00', 'j', 2, 2, 1920),
 (13, 1, 'GB', '2019-04-05 10:00:00', 'k', 1, 1, 800),
 (14, 1, 'GB', '2019-04-06 10:00:00', 'l', 1, 1, 800);
insert into users values (1, x'deadbeef');
insert into api_tokens values (1, 'secret');
insert into store values ('k');
SQL

# One pass rather than the loop: the script is a loop around this, and a test
# that waited for a second pass would be timing rather than behaviour.
SNAPSHOT_SOURCE="$work/data/db.sqlite3" \
SNAPSHOT_TARGET="$work/out/analytics.sqlite3" \
SNAPSHOT_INTERVAL=3600 \
SNAPSHOT_EXCLUDE="location|XX; location-window|YY|2019-04-02 10:30:00|2019-04-02 13:30:00; path|/deploy-probe; agent|Chrome|150|Linux|1920; agent|Firefox||||2019-04-06 00:00:00|2019-04-07 00:00:00; nonsense|whatever" \
    timeout 60 sh "$here/../deploy/snapshot/snapshot.sh" >"$work/log" 2>&1 &

for _ in $(seq 1 60); do
    [ -f "$work/out/analytics.sqlite3" ] && break
    sleep 0.5
done

kill %1 2>/dev/null
wait %1 2>/dev/null

failures=0

check() {
    if [ "$2" = "$3" ]; then
        echo "ok    $1"
    else
        failures=$((failures + 1))
        echo "FAIL  $1: got $2, expected $3"
    fi
}

if [ ! -f "$work/out/analytics.sqlite3" ]; then
    echo "FAIL  the snapshot was written"
    cat "$work/log"
    exit 1
fi

kept=$(sqlite3 "$work/out/analytics.sqlite3" 'select group_concat(hit_id) from (select hit_id from hits order by hit_id)')

check "each rule drops what it names, and only that" \
    "$kept" "2,5,6,9,10,12,13"

check "the live database is not touched" \
    "$(sqlite3 "$work/data/db.sqlite3" 'select count(*) from hits')" "14"

check "the login and its tokens are not in the snapshot" \
    "$(sqlite3 "$work/out/analytics.sqlite3" "select count(*) from sqlite_master where type='table' and name in ('users','api_tokens','store')")" "0"

check "a rule of a kind the script does not know removes nothing" \
    "$(grep -c 'unknown kind' "$work/log")" "1"

check "and says so" \
    "$(grep -c 'nonsense' "$work/log")" "1"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi

echo "all checks passed"
