#!/bin/bash
# version-bump-only.sh BASE HEAD
#
# Exits 0 when the change from BASE to HEAD does nothing but move version
# pins in the files a toolchain bump touches, and non-zero, saying why, for
# anything else. The review workflow approves a change that passes without a
# model review, so this test is the whole of what lands unread: widening the
# file list or the version patterns widens that.

set -euo pipefail

base=$1
head=$2

pin_files='^(versions\.json|\.config/dotnet-tools\.json|analyse-service/Dockerfile|compile-service/Dockerfile|runner/runner\.ghulproj|web/web\.csproj)$'

version='[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.-]+)?'

# Replace each pinned version with a placeholder, so two files that differ
# only in their versions compare equal.
normalise() {
    sed -E \
        -e "s/(\"version\": \")$version\"/\1V\"/" \
        -e "s/^(ARG [A-Z_]+_VERSION=)$version\$/\1V/" \
        -e "s/(<PackageReference Include=\"[Gg]hul\.[A-Za-z.]+\" Version=\")$version\"/\1V\"/"
}

# versions.json is nothing but `"tool": "version"` lines.
normalise_versions() {
    sed -E -e "s/^(\s*\"[A-Za-z]+\": \")$version\"/\1V\"/"
}

changes=$(git diff --name-status "$base" "$head")

if [ -z "$changes" ]; then
    echo "no change"
    exit 1
fi

while read -r status path; do
    if [ "$status" != M ]; then
        echo "not a modification: $status $path"
        exit 1
    fi

    if ! [[ "$path" =~ $pin_files ]]; then
        echo "not a pin file: $path"
        exit 1
    fi

    normalise_this=normalise

    if [ "$path" = versions.json ]; then
        normalise_this=normalise_versions
    fi

    if ! diff <(git show "$base:$path" | $normalise_this) <(git show "$head:$path" | $normalise_this) >/dev/null; then
        echo "changes more than a version: $path"
        exit 1
    fi
done <<< "$changes"

echo "version pins only"
