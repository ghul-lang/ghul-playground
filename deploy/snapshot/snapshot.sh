#!/bin/sh
# A copy of the analytics database for the insights pages to read, taken every
# few minutes.
#
# The pages cannot read the live file. It is in WAL mode, and a reader has to be
# able to create the -shm file beside it, which a read-only mount refuses; a
# read-write mount would put a second writer on the one thing on this host that
# cannot be rebuilt. So this takes a copy instead, and the pages mount only the
# copy, read-only. That is the property worth having: nothing downstream of here
# can write analytics data, and nothing downstream of here can reach the
# original.
#
# The copy is also where visits that are not visitors are removed. The live
# database keeps every row it has ever had - what is recorded is the site
# owner's to clear when they choose, and this must never be the thing that
# clears it - but a copy rebuilt every few minutes can drop whatever the rules
# below name, and a dashboard reading it then needs no filters and holds no
# opinion about who is excluded. Change the rules and the next copy has them.
#
# The rules come from the environment rather than from this repository, which is
# public: which networks and places the site's own people browse from describes
# them rather than the service. See deploy/README.md for the format.
set -eu

SOURCE="${SNAPSHOT_SOURCE:-/data/db.sqlite3}"
TARGET="${SNAPSHOT_TARGET:-/snapshot/analytics.sqlite3}"
INTERVAL="${SNAPSHOT_INTERVAL:-300}"

# Tables the pages have no business holding. `users` carries the dashboard login's
# password hash and `api_tokens` its tokens; `store` is upstream's own scratch
# space. None of them says anything about a visit.
PRIVATE_TABLES="users api_tokens store"

# A quote in a rule would otherwise end the string it sits in. Doubling is
# SQLite's own escape.
escape() {
    printf '%s' "$1" | sed "s/'/''/g"
}

# The hits an agent rule names, as a query for their ids. Each field left empty
# matches anything.
agent_hits() {
    conditions="1 = 1"

    for spec in "2 b.name" "3 b.version" "4 s.name" "5 h.width"; do
        field=${spec%% *}
        column=${spec#* }
        value=$(escape "$(printf '%s' "$1" | cut -d'|' -f"$field")")

        [ -n "$value" ] && conditions="$conditions and $column = '$value'"
    done

    from=$(escape "$(printf '%s' "$1" | cut -d'|' -f6)")
    to=$(escape "$(printf '%s' "$1" | cut -d'|' -f7)")

    [ -n "$from" ] && conditions="$conditions and h.created_at >= '$from'"
    [ -n "$to" ] && conditions="$conditions and h.created_at <= '$to'"

    printf 'select h.hit_id from hits h
            join browsers b on b.browser_id = h.browser_id
            join systems s on s.system_id = h.system_id
            where %s' "$conditions"
}

snapshot() {
    working="${TARGET}.new"

    rm -f "$working"

    # VACUUM INTO rather than a file copy: it reads through the WAL and writes
    # one consistent file, where copying the database and its WAL separately
    # races whatever is being written between the two.
    sqlite3 "$SOURCE" "VACUUM INTO '$working'"

    for table in $PRIVATE_TABLES; do
        sqlite3 "$working" "DROP TABLE IF EXISTS $table" || true
    done

    # One rule per line or separated by `;`, whichever the host finds easier to
    # write - a compose environment file cannot carry a value spanning lines, so
    # `;` is what it will be in practice. Each rule's own fields are separated
    # by `|`, which is not a character any of them can contain; a space is,
    # since a timestamp has one.
    #
    #   location|<prefix>                      every visit recorded in that place
    #   location-window|<prefix>|<from>|<to>   that place, between two times
    #   path|<pattern>                         paths matching a LIKE pattern
    #   agent|<browser>|<version>|<system>|<width>[|<from>|<to>]
    #                                          every visit with a hit from that
    #                                          browser, browser version, system
    #                                          and screen width, optionally only
    #                                          where that hit falls between two
    #                                          times; an empty field matches any
    #
    # An agent rule removes whole visits: every hit of a session with a
    # matching hit goes, so a visit's events leave with its page views.
    #
    # A rule that names nothing removes nothing, so a wrong one is quiet rather
    # than destructive - and the next snapshot is five minutes away regardless.
    printf '%s\n' "${SNAPSHOT_EXCLUDE:-}" | tr ';' '\n' | while IFS= read -r rule; do
        rule=$(printf '%s' "$rule" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

        [ -n "$rule" ] || continue

        kind=$(printf '%s' "$rule" | cut -d'|' -f1)
        first=$(escape "$(printf '%s' "$rule" | cut -d'|' -f2)")

        case "$kind" in
            location)
                sqlite3 "$working" \
                    "delete from hits where location like '$first%'" ;;
            location-window)
                from=$(escape "$(printf '%s' "$rule" | cut -d'|' -f3)")
                to=$(escape "$(printf '%s' "$rule" | cut -d'|' -f4)")
                sqlite3 "$working" \
                    "delete from hits where location like '$first%'
                     and created_at between '$from' and '$to'" ;;
            agent)
                sqlite3 "$working" "delete from hits where hit_id in ($(agent_hits "$rule"))
                     or session in (select session from hits where session is not null
                                    and hit_id in ($(agent_hits "$rule")))" ;;
            path)
                sqlite3 "$working" \
                    "delete from hits where path_id in
                       (select path_id from paths where path like '$first')" ;;
            *)
                echo "snapshot: ignoring rule of unknown kind: $kind" >&2 ;;
        esac
    done

    # Renamed rather than written in place: the pages can open the snapshot at any
    # moment, and rename within one filesystem is atomic, so it sees either the
    # previous copy or the new one and never a half-written file.
    mv "$working" "$TARGET"
}

echo "snapshot: $SOURCE -> $TARGET every ${INTERVAL}s"

while true; do
    if [ -f "$SOURCE" ]; then
        snapshot || echo "snapshot: failed, leaving the previous copy in place" >&2
    else
        echo "snapshot: no database at $SOURCE yet" >&2
    fi

    sleep "$INTERVAL"
done
