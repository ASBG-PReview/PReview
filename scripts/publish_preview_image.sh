#!/usr/bin/env bash
# The publish job serializes writers for each PR and head SHA.
set -euo pipefail

case "${1:-}" in
  prepare)
    test "$#" = 3
    skopeo copy --format v2s2 --dest-compress "$2" "dir:$3" >&2
    skopeo manifest-digest "$3/manifest.json"
    exit
    ;;
  publish)
    test "$#" = 4
    ;;
  *)
    echo "Expected prepare SOURCE DIRECTORY or publish DIRECTORY TAG SIGNED_DIGEST" >&2
    exit 2
    ;;
esac

directory=$2
target="docker://$3"
digest=$4
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
test "$(skopeo manifest-digest "$directory/manifest.json")" = "$digest"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

if skopeo inspect --raw "$target" > "$work/remote" 2> "$work/error"; then
  existing=$(skopeo manifest-digest "$work/remote")
  if [[ "$existing" != "$digest" ]]; then
    # A fresh Gradle/Docker build of the same commit may have different bytes.
    # Keep the first image only if this publisher previously signed that exact digest.
    PREVIEW_DIGEST="$existing" node scripts/preview-publish.mjs verify-intent
    digest=$existing
  fi
else
  if ! grep -Eq ': (manifest unknown|name unknown)(: [^"]*)?"?$' "$work/error"; then
    cat "$work/error" >&2
    exit 1
  fi
  skopeo copy --preserve-digests "dir:$directory" "$target" >&2
fi
skopeo inspect --raw "$target" > "$work/remote"
test "$(skopeo manifest-digest "$work/remote")" = "$digest"
printf '%s\n' "$digest"
