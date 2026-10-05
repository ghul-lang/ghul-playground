#!/usr/bin/env bash
# Compiles every program a ghul.dev page offers to run, so the reader who first
# presses Run on one is answered from the compile service's result cache rather
# than waiting for a compile.
#
# The cache is keyed on the toolchain and the exact source text, so a program
# compiled here is a hit only when the page posts the same bytes. That holds
# for what the pages post unedited: a Rosetta task's or a ghul-examples
# program's file as raw.githubusercontent.com serves it, and a ghul.dev
# example's fullSource from the site's example data. An edit misses and
# compiles as it always did.
#
# The cache lives on a tmpfs inside the compile container and is lost when the
# container restarts, so this runs after every deploy and on a timer
# (deploy/systemd/playground-precompile.timer). It posts to the service on the
# host's loopback port, through the same queue and caps as any reader, with at
# most PRECOMPILE_PARALLEL compiles of its own in flight so readers keep the
# rest of the service's slots.
#
# Usage: deploy/precompile.sh [--list]
#
#   --list   print the source files that would be compiled, and compile none
#
# Environment:
#   PRECOMPILE_SERVICE   the compile endpoint (http://127.0.0.1:5090/compile)
#   PRECOMPILE_DIR       where the content repositories are checked out
#                        (~/.cache/playground-precompile)
#   PRECOMPILE_TARGETS   comma-separated targets to compile for (dotnet)
#   PRECOMPILE_PARALLEL  compiles of this job's in flight at once (2)
#   PRECOMPILE_LIMIT     compile only the first this many programs, for a trial

set -euo pipefail

service="${PRECOMPILE_SERVICE:-http://127.0.0.1:5090/compile}"
work="${PRECOMPILE_DIR:-$HOME/.cache/playground-precompile}"
targets="${PRECOMPILE_TARGETS:-dotnet}"
parallel="${PRECOMPILE_PARALLEL:-2}"
list_only=false

case "${1:-}" in
    --list) list_only=true ;;
    "") ;;
    *) echo "usage: $0 [--list]" >&2; exit 2 ;;
esac

# A fresh shallow clone of each repository at its main branch: that branch is
# what the pages fetch from, and a clone made fresh cannot carry a stale file.
fetch() {
    local name="$1"

    rm -rf "${work:?}/$name"
    git clone --quiet --depth 1 "https://github.com/ghul-lang/$name.git" "$work/$name"
}

mkdir -p "$work"

# One run at a time: a second, from the timer firing while a deploy's run is
# under way, would re-clone the checkouts the first is reading from.
exec 9> "$work.lock"

if ! flock -n 9; then
    echo "another pre-compile run is under way" >&2
    exit 0
fi

fetch ghul-rosetta-code
fetch ghul-examples
fetch ghul-dev

sources="$work/sources"
rm -rf "$sources"
mkdir -p "$sources"

# A collection's programs: <dir>/<name>/<name>.ghul, or for a program in parts,
# <dir>/<name>/<NN-part>/<NN-part>.ghul. A directory holding a
# playground-unsupported file is one the playground will not run.
programs() {
    local root="$1" directory name part

    for directory in "$root"/*/; do
        name=$(basename "$directory")

        if [ -f "$directory/$name.ghul" ]; then
            [ -f "$directory/playground-unsupported" ] || echo "$directory$name.ghul"
            continue
        fi

        for part in "$directory"[0-9][0-9]-*/; do
            [ -d "$part" ] || continue
            name=$(basename "$part")

            [ -f "$part/$name.ghul" ] && [ ! -f "$part/playground-unsupported" ] \
                && echo "$part$name.ghul"
        done
    done
}

{
    programs "$work/ghul-rosetta-code/tasks"
    programs "$work/ghul-examples/examples"
} > "$sources/files.txt"

# A ghul.dev example runs its fullSource; a snippet does not run at all.
examples="$sources/ghul-dev"
mkdir -p "$examples"

for data in "$work/ghul-dev/src/.vitepress/example-data"/*.json; do
    if jq -e '.snippet != true and (.fullSource | type) == "string"' "$data" > /dev/null; then
        jq -j '.fullSource' "$data" > "$examples/$(basename "$data" .json).ghul"
        echo "$examples/$(basename "$data" .json).ghul" >> "$sources/files.txt"
    fi
done

if [ -n "${PRECOMPILE_LIMIT:-}" ]; then
    head -n "$PRECOMPILE_LIMIT" "$sources/files.txt" > "$sources/limited.txt"
    mv "$sources/limited.txt" "$sources/files.txt"
fi

count=$(wc -l < "$sources/files.txt")

if $list_only; then
    cat "$sources/files.txt"
    echo "$count programs" >&2
    exit 0
fi

# One compile: its source and target as the page would post them. A busy
# service is asked again once after its retry-after; anything else is counted
# and left, since a program that does not compile is still a cached answer.
compile_one() {
    local file="$1" target="$2" status

    for attempt in 1 2; do
        status=$(jq -Rs --arg target "$target" '{ source: ., target: $target }' "$file" \
            | curl -s -o /dev/null -w '%{http_code}' -m 60 \
                -H 'content-type: application/json' --data-binary @- "$service" || echo 000)

        [ "$status" = 503 ] && [ "$attempt" = 1 ] && { sleep 5; continue; }
        break
    done

    echo "$status"
}

export -f compile_one
export service

# Run straight after a deploy, the service may still be starting.
health="${service%/compile}/health"

for _ in $(seq 1 60); do
    curl -sf -o /dev/null -m 30 "$health" && break
    sleep 5
done

curl -sf -o /dev/null -m 30 "$health" || { echo "the compile service is not healthy at $health" >&2; exit 1; }

started=$(date +%s)

for target in ${targets//,/ }; do
    tally=$(xargs -a "$sources/files.txt" -d '\n' -P "$parallel" -I{} \
            bash -c 'compile_one "$1" "$2"' _ {} "$target" \
        | sort | uniq -c | awk '{ printf "%s%s x %s", sep, $2, $1; sep = ", " }')

    echo "$target: $count programs, status $tally"
done

echo "done in $(( $(date +%s) - started )) s"
